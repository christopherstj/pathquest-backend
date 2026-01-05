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


def find_local_maxima(
    dem_path: str,
    lat: float,
    lon: float,
    radius_m: float,
    include_global_max: bool = True,
) -> List[Tuple[float, float, float]]:
    """
    Find local maxima (potential summit candidates) within radius.
    
    Returns list of (lat, lon, elevation) for local maxima, sorted by elevation descending.
    Always includes the global maximum within radius even if it's not a strict local max.
    """
    with rasterio.open(dem_path) as ds:
        # Check CRS
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
            center_x, center_y = to_native.transform(lon, lat)
        else:
            min_x, min_y = min_lon, min_lat
            max_x, max_y = max_lon, max_lat
            center_x, center_y = lon, lat
        
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
        
        # Find local maxima using scipy with different neighborhood sizes
        from scipy.ndimage import maximum_filter
        
        maxima = []
        seen_coords = set()
        
        # Try multiple neighborhood sizes to catch peaks at different scales
        for size in [3, 5, 9]:
            local_max = maximum_filter(arr.filled(-np.inf), size=size)
            is_local_max = (arr.data == local_max) & (~arr.mask)
            
            rows, cols = np.where(is_local_max)
            
            for r, c in zip(rows, cols):
                # Convert to geographic coords
                x, y = win_transform * (c + 0.5, r + 0.5)
                
                if from_native:
                    cand_lon, cand_lat = from_native.transform(x, y)
                else:
                    cand_lon, cand_lat = x, y
                
                # Check if within radius
                dist = haversine_m(lat, lon, cand_lat, cand_lon)
                if dist <= radius_m:
                    # Dedupe by rounding coords
                    coord_key = (round(cand_lat, 6), round(cand_lon, 6))
                    if coord_key not in seen_coords:
                        seen_coords.add(coord_key)
                        elev = float(arr[r, c])
                        maxima.append((cand_lat, cand_lon, elev))
        
        # ALWAYS include the global maximum within radius
        if include_global_max:
            # Create distance mask
            valid_mask = ~arr.mask
            if valid_mask.any():
                # Find global max
                global_max_val = arr.max()
                global_max_idx = np.unravel_index(arr.argmax(), arr.shape)
                r, c = global_max_idx
                
                x, y = win_transform * (c + 0.5, r + 0.5)
                if from_native:
                    gmax_lon, gmax_lat = from_native.transform(x, y)
                else:
                    gmax_lon, gmax_lat = x, y
                
                dist = haversine_m(lat, lon, gmax_lat, gmax_lon)
                if dist <= radius_m:
                    coord_key = (round(gmax_lat, 6), round(gmax_lon, 6))
                    if coord_key not in seen_coords:
                        maxima.append((gmax_lat, gmax_lon, float(global_max_val)))
        
        # Sort by elevation descending
        maxima.sort(key=lambda x: -x[2])
        
        return maxima


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
) -> Dict[str, Any]:
    """
    Use ML model to find the best summit candidate.
    
    Args:
        dem_path: Path to DEM file
        model_path: Path to trained model (.joblib)
        lat, lon: Seed coordinates
        radius_m: Search radius
        seed_lat, seed_lon: Original seed coords (for dist_to_seed feature)
        top_k: Return top K candidates
        feature_radius_m: Radius for feature extraction
    
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
    
    # Find local maxima as candidates (more efficient than grid)
    candidates = find_local_maxima(dem_path, lat, lon, radius_m)
    
    if not candidates:
        # Fallback to grid search
        grid_points = generate_candidate_grid(lat, lon, radius_m, step_m=10.0)
        candidates = []
        for cand_lat, cand_lon in grid_points:
            features = extract_features(dem_path, cand_lat, cand_lon, feature_radius_m, seed_lat, seed_lon)
            if "error" not in features:
                candidates.append((cand_lat, cand_lon, features.get("elevation", 0)))
    
    if not candidates:
        return {"error": "no_candidates"}
    
    # Extract features for all candidates
    feature_names = get_feature_names()
    scored_candidates = []
    
    for cand_lat, cand_lon, cand_elev in candidates:
        features = extract_features(dem_path, cand_lat, cand_lon, feature_radius_m, seed_lat, seed_lon)
        
        if "error" in features:
            continue
        
        # Get feature vector
        feature_vec = features_to_vector(features)
        if feature_vec is None:
            continue
        
        # Handle NaN/Inf
        feature_vec = [0.0 if (np.isnan(v) or np.isinf(v)) else v for v in feature_vec]
        
        # Predict probability
        try:
            proba = model.predict_proba([feature_vec])[0][1]  # Probability of class 1 (summit)
        except Exception:
            proba = 0.0
        
        dist_from_seed = haversine_m(seed_lat, seed_lon, cand_lat, cand_lon)
        
        scored_candidates.append({
            "lat": cand_lat,
            "lon": cand_lon,
            "elevation_m": features.get("elevation", cand_elev),
            "ml_probability": float(proba),
            "distance_from_seed_m": dist_from_seed,
            "features": {name: features[name] for name in feature_names},
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
        "candidates_evaluated": len(scored_candidates),
        "top_candidates": scored_candidates[:top_k],
        # Include info about highest-elevation candidate if different from ML best
        "highest_elev_candidate": {
            "lat": highest_elev_candidate["lat"],
            "lon": highest_elev_candidate["lon"],
            "elevation_m": highest_elev_candidate["elevation_m"],
            "ml_probability": highest_elev_candidate["ml_probability"],
        } if highest_elev_candidate != best else None,
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
            )
            result["peak_id"] = peak_id
        
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()

