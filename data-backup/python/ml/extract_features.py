#!/usr/bin/env python3
"""
Extract topographic features from DEM for ML summit detection.

Features extracted:
- elev_rank: Percentile rank within search radius (1.0 = highest)
- gradient_N/S/E/W/NE/SE/SW/NW: Elevation drop in 8 directions
- min_gradient: Minimum of all 8 gradients (ridge vs peak detection)
- local_relief: Max - min elevation in patch
- pct_lower: % of cells lower than candidate
- curvature: 2nd derivative (laplacian) - positive = convex summit
- dist_to_seed: Distance from original coordinates (if provided)
"""

import math
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from typing import Optional, Dict, Any, Tuple
from pyproj import Transformer


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance between two points in meters."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def deg_window_from_radius(lat: float, lon: float, radius_m: float) -> Tuple[float, float, float, float]:
    """Convert radius in meters to a bounding box in degrees."""
    lat_deg_per_m = 1.0 / 111320.0
    lon_deg_per_m = 1.0 / (111320.0 * math.cos(math.radians(lat)))
    dlat = radius_m * lat_deg_per_m
    dlon = radius_m * lon_deg_per_m
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def compute_directional_gradients(
    arr: np.ma.MaskedArray,
    center_row: int,
    center_col: int,
    cell_size_m: float,
    distance_cells: int = 10
) -> Dict[str, float]:
    """
    Compute elevation gradients in 8 directions from center point.
    
    Returns the elevation DROP (positive = lower terrain) in each direction,
    measured at `distance_cells` away from center.
    """
    center_elev = arr[center_row, center_col]
    if np.ma.is_masked(center_elev):
        return {d: 0.0 for d in ["N", "S", "E", "W", "NE", "SE", "SW", "NW"]}
    
    directions = {
        "N": (-1, 0),
        "S": (1, 0),
        "E": (0, 1),
        "W": (0, -1),
        "NE": (-1, 1),
        "SE": (1, 1),
        "SW": (1, -1),
        "NW": (-1, -1),
    }
    
    gradients = {}
    for name, (dr, dc) in directions.items():
        target_row = center_row + dr * distance_cells
        target_col = center_col + dc * distance_cells
        
        # Check bounds
        if 0 <= target_row < arr.shape[0] and 0 <= target_col < arr.shape[1]:
            target_elev = arr[target_row, target_col]
            if not np.ma.is_masked(target_elev):
                # Positive gradient = terrain drops away (good for summit)
                gradients[name] = float(center_elev - target_elev)
            else:
                gradients[name] = 0.0
        else:
            gradients[name] = 0.0
    
    return gradients


def compute_curvature(arr: np.ma.MaskedArray, row: int, col: int, cell_size_m: float) -> float:
    """
    Compute Laplacian curvature at a point.
    Positive = convex (summit), Negative = concave (valley)
    """
    if row < 1 or row >= arr.shape[0] - 1 or col < 1 or col >= arr.shape[1] - 1:
        return 0.0
    
    center = arr[row, col]
    if np.ma.is_masked(center):
        return 0.0
    
    # Get 4-neighbors
    neighbors = [
        arr[row - 1, col],  # N
        arr[row + 1, col],  # S
        arr[row, col - 1],  # W
        arr[row, col + 1],  # E
    ]
    
    if any(np.ma.is_masked(n) for n in neighbors):
        return 0.0
    
    # Laplacian: sum of 2nd derivatives
    laplacian = (sum(neighbors) - 4 * center) / (cell_size_m ** 2)
    
    # Negate so positive = convex summit
    return -float(laplacian)


def extract_features(
    dem_path_or_ds,
    lat: float,
    lon: float,
    radius_m: float = 50.0,
    seed_lat: Optional[float] = None,
    seed_lon: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Extract topographic features from DEM around a point.
    
    Args:
        dem_path_or_ds: Path to DEM file OR an already-open rasterio dataset
        lat, lon: Coordinates of point to extract features for
        radius_m: Radius around point to analyze (default 50m)
        seed_lat, seed_lon: Original seed coordinates (for dist_to_seed feature)
    
    Returns:
        Dictionary of features
    """
    # Support both path (string) and already-open dataset
    if isinstance(dem_path_or_ds, str):
        ds = rasterio.open(dem_path_or_ds)
        should_close = True
    else:
        ds = dem_path_or_ds
        should_close = False
    
    try:
        return _extract_features_from_ds(ds, lat, lon, radius_m, seed_lat, seed_lon)
    finally:
        if should_close:
            ds.close()


def _extract_features_from_ds(
    ds,
    lat: float,
    lon: float,
    radius_m: float,
    seed_lat: Optional[float],
    seed_lon: Optional[float],
) -> Dict[str, Any]:
    """Internal: extract features from an already-open dataset."""
    # Check if we need coordinate transformation
    crs = ds.crs
    to_native = None
    from_native = None
    
    if crs and not crs.is_geographic:
        to_native = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        from_native = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    
    # Get bounding box
    min_lon, min_lat, max_lon, max_lat = deg_window_from_radius(lat, lon, radius_m)
    
    # Transform to native CRS if needed
    if to_native:
        min_x, min_y = to_native.transform(min_lon, min_lat)
        max_x, max_y = to_native.transform(max_lon, max_lat)
        center_x, center_y = to_native.transform(lon, lat)
    else:
        min_x, min_y = min_lon, min_lat
        max_x, max_y = max_lon, max_lat
        center_x, center_y = lon, lat
    
    # Create window
    try:
        window = from_bounds(min_x, min_y, max_x, max_y, ds.transform)
    except Exception:
        return {"error": "window_error"}
    
    # Clip window to dataset bounds
    window = window.intersection(rasterio.windows.Window(0, 0, ds.width, ds.height))
    
    if window.width < 3 or window.height < 3:
        return {"error": "window_too_small"}
    
    # Read data
    arr = ds.read(1, window=window, masked=True)
    
    if arr.count() == 0:
        return {"error": "no_data"}
    
    # Get transform for this window
    win_transform = ds.window_transform(window)
    
    # Find center point in array coordinates
    inv_transform = ~win_transform
    center_col, center_row = inv_transform * (center_x, center_y)
    center_row, center_col = int(round(center_row)), int(round(center_col))
    
    # Clamp to array bounds
    center_row = max(0, min(arr.shape[0] - 1, center_row))
    center_col = max(0, min(arr.shape[1] - 1, center_col))
    
    center_elev = arr[center_row, center_col]
    if np.ma.is_masked(center_elev):
        return {"error": "center_masked"}
    
    center_elev = float(center_elev)
    
    # Estimate cell size in meters
    if crs and not crs.is_geographic:
        cell_size_m = abs(win_transform.a)  # Assume square cells
    else:
        # Geographic CRS - approximate meters
        cell_size_m = abs(win_transform.a) * 111320 * math.cos(math.radians(lat))
    
    # === Feature Extraction ===
    
    # 1. Elevation percentile rank (1.0 = highest point)
    valid_elevs = arr.compressed()
    elev_rank = float(np.sum(valid_elevs <= center_elev)) / len(valid_elevs)
    
    # 2. Directional gradients (10 cells away, ~10-50m depending on resolution)
    distance_cells = max(1, int(round(radius_m / 5 / cell_size_m)))  # ~1/5 of radius
    gradients = compute_directional_gradients(arr, center_row, center_col, cell_size_m, distance_cells)
    
    # 3. Min gradient (for ridge vs peak detection)
    min_gradient = min(gradients.values())
    
    # 4. Local relief
    local_relief = float(valid_elevs.max() - valid_elevs.min())
    
    # 5. Percentage of cells lower than center
    pct_lower = float(np.sum(valid_elevs < center_elev)) / len(valid_elevs)
    
    # 6. Curvature (Laplacian)
    curvature = compute_curvature(arr, center_row, center_col, cell_size_m)
    
    # 7. Distance to seed (if provided)
    if seed_lat is not None and seed_lon is not None:
        dist_to_seed = haversine_m(lat, lon, seed_lat, seed_lon)
    else:
        dist_to_seed = 0.0
    
    # 8. Additional features
    # Mean gradient (average drop in all directions)
    mean_gradient = sum(gradients.values()) / len(gradients)
    
    # Gradient variance (how uniform is the drop?)
    grad_values = list(gradients.values())
    grad_variance = float(np.var(grad_values))
    
    return {
        "lat": lat,
        "lon": lon,
        "elevation": center_elev,
        "elev_rank": elev_rank,
        "gradient_N": gradients["N"],
        "gradient_S": gradients["S"],
        "gradient_E": gradients["E"],
        "gradient_W": gradients["W"],
        "gradient_NE": gradients["NE"],
        "gradient_SE": gradients["SE"],
        "gradient_SW": gradients["SW"],
        "gradient_NW": gradients["NW"],
        "min_gradient": min_gradient,
        "mean_gradient": mean_gradient,
        "grad_variance": grad_variance,
        "local_relief": local_relief,
        "pct_lower": pct_lower,
        "curvature": curvature,
        "dist_to_seed": dist_to_seed,
    }


def get_feature_names() -> list:
    """Return list of feature names in consistent order for ML."""
    return [
        "elev_rank",
        "gradient_N",
        "gradient_S",
        "gradient_E",
        "gradient_W",
        "gradient_NE",
        "gradient_SE",
        "gradient_SW",
        "gradient_NW",
        "min_gradient",
        "mean_gradient",
        "grad_variance",
        "local_relief",
        "pct_lower",
        "curvature",
        "dist_to_seed",
    ]


def features_to_vector(features: Dict[str, Any]) -> Optional[list]:
    """Convert feature dict to vector for ML model."""
    if "error" in features:
        return None
    
    return [features[name] for name in get_feature_names()]


# === CLI for testing ===
if __name__ == "__main__":
    import sys
    import json
    
    if len(sys.argv) < 4:
        print("Usage: python extract_features.py <dem_path> <lat> <lon> [radius_m] [seed_lat] [seed_lon]")
        sys.exit(1)
    
    dem_path = sys.argv[1]
    lat = float(sys.argv[2])
    lon = float(sys.argv[3])
    radius_m = float(sys.argv[4]) if len(sys.argv) > 4 else 50.0
    seed_lat = float(sys.argv[5]) if len(sys.argv) > 5 else None
    seed_lon = float(sys.argv[6]) if len(sys.argv) > 6 else None
    
    features = extract_features(dem_path, lat, lon, radius_m, seed_lat, seed_lon)
    print(json.dumps(features, indent=2))

