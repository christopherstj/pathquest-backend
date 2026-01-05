#!/usr/bin/env python3
"""
ML-based summit detection for peak snapping.

Reads JSONL from stdin with peak_id, lat, lon, radius_m.
Generates candidate points, extracts features, scores with ML model.
Outputs JSONL with best candidate per peak.

Usage:
    echo '{"peak_id":"123","lat":39.1,"lon":-106.4,"radius_m":100}' | \
    python predict_summit.py --dem-path /path/to/dem.vrt --model-path models/summit_model.joblib
"""

import sys
import json
import math
import argparse
from typing import Dict, Any, List, Optional, Tuple

import numpy as np
import rasterio
import joblib
from pyproj import Transformer
from rasterio.windows import from_bounds

from extract_features import (
    extract_features,
    get_feature_names,
    features_to_vector,
    haversine_m,
    deg_window_from_radius,
)


def generate_candidate_grid(
    lat: float,
    lon: float,
    radius_m: float,
    step_m: float = 5.0,
) -> List[Tuple[float, float]]:
    """
    Generate a grid of candidate points within radius of center.
    
    Returns list of (lat, lon) tuples.
    """
    candidates = []
    
    lat_per_m = 1.0 / 111320.0
    lon_per_m = 1.0 / (111320.0 * math.cos(math.radians(lat)))
    
    steps = int(radius_m / step_m)
    
    for i in range(-steps, steps + 1):
        for j in range(-steps, steps + 1):
            dlat = i * step_m * lat_per_m
            dlon = j * step_m * lon_per_m
            
            cand_lat = lat + dlat
            cand_lon = lon + dlon
            
            # Check distance from center
            dist = haversine_m(lat, lon, cand_lat, cand_lon)
            if dist <= radius_m:
                candidates.append((cand_lat, cand_lon))
    
    return candidates


def find_top_elevation_candidates(
    dem_path_or_ds,
    lat: float,
    lon: float,
    radius_m: float,
    top_n: int = 15,
    min_separation_m: float = 5.0,
) -> List[Tuple[float, float, float]]:
    """
    Find top N highest elevation cells within radius.
    
    Much simpler and faster than local maxima detection.
    Returns list of (lat, lon, elevation) sorted by elevation descending.
    
    Uses min_separation_m to avoid returning many cells from same flat area.
    
    Args:
        dem_path_or_ds: Path to DEM file OR an already-open rasterio dataset
    """
    # Support both path (string) and already-open dataset
    if isinstance(dem_path_or_ds, str):
        ds = rasterio.open(dem_path_or_ds)
        should_close = True
    else:
        ds = dem_path_or_ds
        should_close = False
    
    try:
        crs = ds.crs
        to_native = None
        from_native = None
        
        if crs and not crs.is_geographic:
            to_native = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
            from_native = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        
        # Get bounding box
        min_lon, min_lat, max_lon, max_lat = deg_window_from_radius(lat, lon, radius_m)
        
        if to_native:
            min_x, min_y = to_native.transform(min_lon, min_lat)
            max_x, max_y = to_native.transform(max_lon, max_lat)
        else:
            min_x, min_y = min_lon, min_lat
            max_x, max_y = max_lon, max_lat
        
        try:
            window = from_bounds(min_x, min_y, max_x, max_y, ds.transform)
            window = window.intersection(rasterio.windows.Window(0, 0, ds.width, ds.height))
        except Exception:
            return []
        
        if window.width < 3 or window.height < 3:
            return []
        
        arr = ds.read(1, window=window, masked=True)
        
        if arr.count() == 0:
            return []
        
        win_transform = ds.window_transform(window)
        
        # Flatten and get indices sorted by elevation (descending)
        flat = arr.flatten()
        valid_indices = ~flat.mask if hasattr(flat, 'mask') else np.ones(len(flat), dtype=bool)
        
        # Get indices of valid cells sorted by elevation descending
        valid_flat_indices = np.where(valid_indices)[0]
        sorted_indices = valid_flat_indices[np.argsort(-flat[valid_flat_indices])]
        
        candidates = []
        
        for flat_idx in sorted_indices:
            if len(candidates) >= top_n:
                break
            
            # Convert flat index to row, col
            r, c = np.unravel_index(flat_idx, arr.shape)
            elev = float(arr[r, c])
            
            # Convert to geographic coords
            x, y = win_transform * (c + 0.5, r + 0.5)
            
            if from_native:
                cand_lon, cand_lat = from_native.transform(x, y)
            else:
                cand_lon, cand_lat = x, y
            
            # Check if within radius
            dist_from_center = haversine_m(lat, lon, cand_lat, cand_lon)
            if dist_from_center > radius_m:
                continue
            
            # Check separation from existing candidates
            too_close = False
            for existing_lat, existing_lon, _ in candidates:
                if haversine_m(cand_lat, cand_lon, existing_lat, existing_lon) < min_separation_m:
                    too_close = True
                    break
            
            if not too_close:
                candidates.append((cand_lat, cand_lon, elev))
        
        return candidates
    finally:
        if should_close:
            ds.close()


# Keep old function name as alias for compatibility
def find_local_maxima(
    dem_path_or_ds,
    lat: float,
    lon: float,
    radius_m: float,
    include_global_max: bool = True,
) -> List[Tuple[float, float, float]]:
    """Alias for find_top_elevation_candidates for compatibility."""
    return find_top_elevation_candidates(dem_path_or_ds, lat, lon, radius_m, top_n=15, min_separation_m=5.0)


def predict_summit(
    dem_path: str,
    model_path: str,
    lat: float,
    lon: float,
    radius_m: float,
    seed_lat: Optional[float] = None,
    seed_lon: Optional[float] = None,
    top_k: int = 5,
    feature_radius_m: float = 50.0,
    max_candidates_to_score: int = 15,  # Only score top N by elevation
) -> Dict[str, Any]:
    """
    Use ML model to find the best summit candidate.
    
    Args:
        dem_path: Path to DEM file
        model_path: Path to trained model (.joblib)
        lat, lon: Seed coordinates
        radius_m: Search radius
        seed_lat, seed_lon: Original seed coords (for dist_to_seed feature)
        top_k: Return top K candidates in output
        feature_radius_m: Radius for feature extraction
        max_candidates_to_score: Only extract features for top N candidates by elevation
    
    Returns:
        Dictionary with best candidate and alternatives
    """
    # Load model
    try:
        model = joblib.load(model_path)
    except Exception as e:
        return {"error": f"model_load_failed: {e}"}
    
    # Use seed coords if not provided
    if seed_lat is None:
        seed_lat = lat
    if seed_lon is None:
        seed_lon = lon
    
    # =========================================================================
    # CRITICAL OPTIMIZATION: Read DEM into memory ONCE
    # =========================================================================
    # We need a window that covers both:
    #   - search_radius (for candidate finding)
    #   - feature_radius (for feature extraction around candidates)
    # So we read search_radius + feature_radius to cover all cases
    total_radius = radius_m + feature_radius_m
    
    with rasterio.open(dem_path) as ds:
        crs = ds.crs
        to_native = None
        from_native = None
        
        if crs and not crs.is_geographic:
            to_native = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
            from_native = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        
        # Get bounding box for the full area we need
        min_lon, min_lat, max_lon, max_lat = deg_window_from_radius(lat, lon, total_radius)
        
        if to_native:
            min_x, min_y = to_native.transform(min_lon, min_lat)
            max_x, max_y = to_native.transform(max_lon, max_lat)
            center_x, center_y = to_native.transform(lon, lat)
        else:
            min_x, min_y = min_lon, min_lat
            max_x, max_y = max_lon, max_lat
            center_x, center_y = lon, lat
        
        try:
            window = from_bounds(min_x, min_y, max_x, max_y, ds.transform)
            window = window.intersection(rasterio.windows.Window(0, 0, ds.width, ds.height))
        except Exception:
            return {"error": "window_error"}
        
        if window.width < 3 or window.height < 3:
            return {"error": "window_too_small"}
        
        # READ ONCE - this is the only disk I/O!
        master_arr = ds.read(1, window=window, masked=True)
        master_transform = ds.window_transform(window)
        
        if master_arr.count() == 0:
            return {"error": "no_data"}
        
        # Get cell size for feature calculations
        if crs and not crs.is_geographic:
            cell_size_m = abs(master_transform.a)
        else:
            cell_size_m = abs(master_transform.a) * 111320 * math.cos(math.radians(lat))
    
    # =========================================================================
    # From here on, ALL operations use the in-memory master_arr
    # =========================================================================
    
    # Find top candidates from in-memory array
    candidates = _find_candidates_from_array(
        master_arr, master_transform, from_native,
        lat, lon, radius_m, center_x, center_y,
        top_n=max_candidates_to_score, min_separation_m=5.0
    )
    
    if not candidates:
        return {"error": "no_candidates"}
    
    total_candidates_found = len(candidates)
    
    # Extract features and score candidates - all from in-memory array
    feature_names = get_feature_names()
    scored_candidates = []
    
    for cand_lat, cand_lon, cand_elev in candidates:
        # Extract features from in-memory array
        features = _extract_features_from_array(
            master_arr, master_transform, from_native, to_native,
            cand_lat, cand_lon, feature_radius_m, cell_size_m,
            seed_lat, seed_lon
        )
        
        if features is None:
            continue
        
        # Get feature vector
        feature_vec = [features.get(name, 0.0) for name in feature_names]
        
        # Handle NaN/Inf
        feature_vec = [0.0 if (np.isnan(v) or np.isinf(v)) else v for v in feature_vec]
        
        # Predict probability
        try:
            proba = model.predict_proba([feature_vec])[0][1]
        except Exception:
            proba = 0.0
        
        dist_from_seed = haversine_m(seed_lat, seed_lon, cand_lat, cand_lon)
        
        scored_candidates.append({
            "lat": cand_lat,
            "lon": cand_lon,
            "elevation_m": cand_elev,
            "ml_probability": float(proba),
            "distance_from_seed_m": dist_from_seed,
            "features": features,
        })
    
    if not scored_candidates:
        return {"error": "no_valid_candidates"}
    
    # Sort by ML probability (descending), then by elevation (descending)
    scored_candidates.sort(key=lambda c: (-c["ml_probability"], -c["elevation_m"]))
    
    # Select best candidate
    best = scored_candidates[0]
    
    # Also find the highest-elevation candidate for comparison
    highest_elev_candidate = max(scored_candidates, key=lambda c: c["elevation_m"])
    
    return {
        "snapped_lat": best["lat"],
        "snapped_lon": best["lon"],
        "elevation_m": best["elevation_m"],
        "ml_probability": best["ml_probability"],
        "snapped_distance_m": best["distance_from_seed_m"],
        "candidates_found": total_candidates_found,
        "candidates_evaluated": len(scored_candidates),
        "top_candidates": scored_candidates[:top_k],
        "highest_elev_candidate": {
            "lat": highest_elev_candidate["lat"],
            "lon": highest_elev_candidate["lon"],
            "elevation_m": highest_elev_candidate["elevation_m"],
            "ml_probability": highest_elev_candidate["ml_probability"],
        } if highest_elev_candidate != best else None,
    }


def _find_candidates_from_array(
    arr: np.ma.MaskedArray,
    transform,
    from_native,
    center_lat: float,
    center_lon: float,
    radius_m: float,
    center_x: float,
    center_y: float,
    top_n: int = 15,
    min_separation_m: float = 5.0,
) -> List[Tuple[float, float, float]]:
    """Find top N highest elevation candidates from an in-memory array."""
    
    # Flatten and sort by elevation
    flat = arr.flatten()
    valid_indices = ~flat.mask if hasattr(flat, 'mask') else np.ones(len(flat), dtype=bool)
    valid_flat_indices = np.where(valid_indices)[0]
    
    if len(valid_flat_indices) == 0:
        return []
    
    sorted_indices = valid_flat_indices[np.argsort(-flat[valid_flat_indices])]
    
    candidates = []
    
    for flat_idx in sorted_indices:
        if len(candidates) >= top_n:
            break
        
        r, c = np.unravel_index(flat_idx, arr.shape)
        elev = float(arr[r, c])
        
        # Convert to geographic coords
        x, y = transform * (c + 0.5, r + 0.5)
        
        if from_native:
            cand_lon, cand_lat = from_native.transform(x, y)
        else:
            cand_lon, cand_lat = x, y
        
        # Check if within search radius
        dist_from_center = haversine_m(center_lat, center_lon, cand_lat, cand_lon)
        if dist_from_center > radius_m:
            continue
        
        # Check separation from existing candidates
        too_close = False
        for existing_lat, existing_lon, _ in candidates:
            if haversine_m(cand_lat, cand_lon, existing_lat, existing_lon) < min_separation_m:
                too_close = True
                break
        
        if not too_close:
            candidates.append((cand_lat, cand_lon, elev))
    
    return candidates


def _extract_features_from_array(
    master_arr: np.ma.MaskedArray,
    master_transform,
    from_native,
    to_native,
    lat: float,
    lon: float,
    radius_m: float,
    cell_size_m: float,
    seed_lat: float,
    seed_lon: float,
) -> Optional[Dict[str, float]]:
    """Extract ML features from an in-memory array (no disk I/O)."""
    
    # Convert lat/lon to array coordinates
    if to_native:
        x, y = to_native.transform(lon, lat)
    else:
        x, y = lon, lat
    
    inv_transform = ~master_transform
    col, row = inv_transform * (x, y)
    center_row, center_col = int(round(row)), int(round(col))
    
    # Compute window size in cells
    cells_radius = int(math.ceil(radius_m / cell_size_m))
    
    # Get bounds for this feature window within the master array
    r_min = max(0, center_row - cells_radius)
    r_max = min(master_arr.shape[0], center_row + cells_radius + 1)
    c_min = max(0, center_col - cells_radius)
    c_max = min(master_arr.shape[1], center_col + cells_radius + 1)
    
    if r_max - r_min < 3 or c_max - c_min < 3:
        return None
    
    # Extract sub-array (this is just numpy slicing, instant)
    arr = master_arr[r_min:r_max, c_min:c_max]
    
    # Adjust center position relative to sub-array
    local_row = center_row - r_min
    local_col = center_col - c_min
    
    # Clamp to bounds
    local_row = max(0, min(arr.shape[0] - 1, local_row))
    local_col = max(0, min(arr.shape[1] - 1, local_col))
    
    center_elev = arr[local_row, local_col]
    if np.ma.is_masked(center_elev):
        return None
    
    center_elev = float(center_elev)
    valid_elevs = arr.compressed()
    
    if len(valid_elevs) == 0:
        return None
    
    # === Compute features ===
    
    # 1. Elevation rank
    elev_rank = float(np.sum(valid_elevs <= center_elev)) / len(valid_elevs)
    
    # 2. Directional gradients
    distance_cells = max(1, int(round(radius_m / 5 / cell_size_m)))
    gradients = {}
    directions = {
        "N": (-1, 0), "S": (1, 0), "E": (0, 1), "W": (0, -1),
        "NE": (-1, 1), "SE": (1, 1), "SW": (1, -1), "NW": (-1, -1),
    }
    
    for name, (dr, dc) in directions.items():
        tr = local_row + dr * distance_cells
        tc = local_col + dc * distance_cells
        if 0 <= tr < arr.shape[0] and 0 <= tc < arr.shape[1]:
            target_elev = arr[tr, tc]
            if not np.ma.is_masked(target_elev):
                gradients[name] = float(center_elev - target_elev)
            else:
                gradients[name] = 0.0
        else:
            gradients[name] = 0.0
    
    min_gradient = min(gradients.values())
    mean_gradient = sum(gradients.values()) / len(gradients)
    grad_variance = float(np.var(list(gradients.values())))
    
    # 3. Local relief
    local_relief = float(valid_elevs.max() - valid_elevs.min())
    
    # 4. Percent lower
    pct_lower = float(np.sum(valid_elevs < center_elev)) / len(valid_elevs)
    
    # 5. Curvature (Laplacian)
    curvature = 0.0
    if 1 <= local_row < arr.shape[0] - 1 and 1 <= local_col < arr.shape[1] - 1:
        neighbors = [
            arr[local_row - 1, local_col],
            arr[local_row + 1, local_col],
            arr[local_row, local_col - 1],
            arr[local_row, local_col + 1],
        ]
        if not any(np.ma.is_masked(n) for n in neighbors):
            laplacian = (sum(float(n) for n in neighbors) - 4 * center_elev) / (cell_size_m ** 2)
            curvature = -laplacian  # Positive = convex summit
    
    # 6. Distance to seed
    dist_to_seed = haversine_m(lat, lon, seed_lat, seed_lon)
    
    return {
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


def iter_jsonl(stream):
    """Iterate over JSONL input."""
    for line in stream:
        line = line.strip()
        if line:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def main():
    parser = argparse.ArgumentParser(description="ML-based summit detection")
    parser.add_argument("--dem-path", required=True, help="Path to DEM file (GeoTIFF or VRT)")
    parser.add_argument("--model-path", required=True, help="Path to trained model (.joblib)")
    parser.add_argument("--feature-radius", type=float, default=50.0, help="Feature extraction radius (m)")
    parser.add_argument("--top-k", type=int, default=5, help="Number of top candidates to return")
    parser.add_argument("--max-candidates", type=int, default=15, help="Max candidates to score (top N by elevation)")
    
    args = parser.parse_args()
    
    for item in iter_jsonl(sys.stdin):
        peak_id = item.get("peak_id", "unknown")
        lat = item.get("lat")
        lon = item.get("lon")
        radius_m = item.get("radius_m", 100.0)
        seed_lat = item.get("seed_lat", lat)
        seed_lon = item.get("seed_lon", lon)
        
        if lat is None or lon is None:
            result = {"peak_id": peak_id, "error": "missing_coords"}
        else:
            result = predict_summit(
                args.dem_path,
                args.model_path,
                lat,
                lon,
                radius_m,
                seed_lat,
                seed_lon,
                top_k=args.top_k,
                feature_radius_m=args.feature_radius,
                max_candidates_to_score=args.max_candidates,
            )
            result["peak_id"] = peak_id
        
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()

