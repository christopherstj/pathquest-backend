#!/usr/bin/env python3
"""
Generate training data for ML summit detection.

Queries verified peaks from the database (14ers + DEM-verified 13ers),
generates negative samples, extracts features, and outputs training_data.csv.

Usage:
    python generate_training_data.py --dem-path <path> --output <csv>

Environment variables for DB connection:
    PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE
"""

import os
import sys
import math
import random
import argparse
import json
from typing import List, Dict, Any, Tuple, Optional

import numpy as np
import pandas as pd
import psycopg2

from extract_features import extract_features, get_feature_names, features_to_vector


def get_db_connection():
    """Create database connection from environment variables."""
    return psycopg2.connect(
        host=os.environ.get("PG_HOST", "127.0.0.1"),
        port=os.environ.get("PG_PORT", "5432"),
        user=os.environ.get("PG_USER", "local-user"),
        password=os.environ.get("PG_PASSWORD", ""),
        database=os.environ.get("PG_DATABASE", "operations"),
    )


def fetch_verified_peaks(
    conn,
    min_elevation_14er: float = 4267.0,  # 14,000 ft in meters
    max_snap_distance_13er: float = 8.0,  # meters
) -> List[Dict[str, Any]]:
    """
    Fetch verified peaks from database.
    
    Returns peaks that are either:
    - 14ers (elevation >= 4267m) - trusted ground truth
    - 13ers with snapped_distance_m < threshold - DEM-verified
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT 
                p.id,
                p.name,
                p.elevation,
                ST_Y(p.snapped_coords) AS lat,
                ST_X(p.snapped_coords) AS lon,
                p.snapped_distance_m,
                ST_Y(p.seed_coords) AS seed_lat,
                ST_X(p.seed_coords) AS seed_lon
            FROM peaks p
            WHERE p.source_origin = '14ers'
              AND p.snapped_coords IS NOT NULL
              AND p.snapped_distance_m IS NOT NULL
              AND (
                  p.elevation >= %s  -- 14ers: all included
                  OR p.snapped_distance_m < %s  -- 13ers: DEM-verified only
              )
            ORDER BY p.elevation DESC
        """, (min_elevation_14er, max_snap_distance_13er))
        
        columns = [desc[0] for desc in cur.description]
        peaks = [dict(zip(columns, row)) for row in cur.fetchall()]
    
    return peaks


def generate_negative_sample(
    lat: float,
    lon: float,
    min_distance_m: float = 50.0,
    max_distance_m: float = 150.0,
) -> Tuple[float, float]:
    """
    Generate a random point at a distance from the summit.
    
    The point is placed in a random direction, at a random distance
    between min_distance_m and max_distance_m.
    """
    # Random angle (radians)
    angle = random.uniform(0, 2 * math.pi)
    
    # Random distance
    distance = random.uniform(min_distance_m, max_distance_m)
    
    # Convert to lat/lon offset
    lat_per_m = 1.0 / 111320.0
    lon_per_m = 1.0 / (111320.0 * math.cos(math.radians(lat)))
    
    dlat = distance * math.cos(angle) * lat_per_m
    dlon = distance * math.sin(angle) * lon_per_m
    
    return lat + dlat, lon + dlon


def find_secondary_peaks(
    dem_path: str,
    lat: float,
    lon: float,
    radius_m: float = 150.0,
    min_prominence_m: float = 5.0,
) -> List[Tuple[float, float, float]]:
    """
    Find secondary peaks (local maxima) near the true summit.
    
    These are "hard negatives" - points that look like summits but aren't
    the highest point. Critical for training ridge/dual-peak detection.
    
    Returns list of (lat, lon, elevation) for secondary peaks.
    """
    import rasterio
    from rasterio.windows import from_bounds
    from scipy.ndimage import maximum_filter
    from pyproj import Transformer
    
    with rasterio.open(dem_path) as ds:
        crs = ds.crs
        to_native = None
        from_native = None
        
        if crs and not crs.is_geographic:
            to_native = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
            from_native = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        
        # Get bounding box
        lat_per_m = 1.0 / 111320.0
        lon_per_m = 1.0 / (111320.0 * math.cos(math.radians(lat)))
        dlat = radius_m * lat_per_m
        dlon = radius_m * lon_per_m
        
        min_lon, min_lat = lon - dlon, lat - dlat
        max_lon, max_lat = lon + dlon, lat + dlat
        
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
        
        if window.width < 5 or window.height < 5:
            return []
        
        arr = ds.read(1, window=window, masked=True)
        if arr.count() == 0:
            return []
        
        win_transform = ds.window_transform(window)
        
        # Find local maxima (5x5 window)
        local_max = maximum_filter(arr.filled(-np.inf), size=5)
        is_local_max = (arr.data == local_max) & (~arr.mask)
        
        # Get the true summit elevation (should be the max)
        true_summit_elev = float(arr.max())
        
        # Find secondary peaks (local max but not the global max)
        secondary = []
        rows, cols = np.where(is_local_max)
        
        for r, c in zip(rows, cols):
            elev = float(arr[r, c])
            
            # Skip if this IS the true summit
            if abs(elev - true_summit_elev) < 0.5:
                continue
            
            # Skip if too low (not a significant secondary peak)
            if true_summit_elev - elev > 50:  # More than 50m lower
                continue
            
            # Must have some prominence (not just noise)
            if true_summit_elev - elev < min_prominence_m:
                continue
            
            # Convert to geographic coords
            x, y = win_transform * (c + 0.5, r + 0.5)
            if from_native:
                sec_lon, sec_lat = from_native.transform(x, y)
            else:
                sec_lon, sec_lat = x, y
            
            secondary.append((sec_lat, sec_lon, elev))
        
        return secondary


def find_ridge_points(
    dem_path: str,
    summit_lat: float,
    summit_lon: float,
    radius_m: float = 100.0,
    num_points: int = 4,
) -> List[Tuple[float, float]]:
    """
    Find points along ridges leading to the summit.
    
    These are "hard negatives" - high points that drop in only 2 directions
    (along ridge axis) but are flat or rising in the other 2 (perpendicular).
    
    Returns list of (lat, lon) for ridge points.
    """
    import rasterio
    from rasterio.windows import from_bounds
    from scipy.ndimage import sobel
    from pyproj import Transformer
    
    with rasterio.open(dem_path) as ds:
        crs = ds.crs
        to_native = None
        from_native = None
        
        if crs and not crs.is_geographic:
            to_native = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
            from_native = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        
        lat_per_m = 1.0 / 111320.0
        lon_per_m = 1.0 / (111320.0 * math.cos(math.radians(summit_lat)))
        dlat = radius_m * lat_per_m
        dlon = radius_m * lon_per_m
        
        min_lon, min_lat = summit_lon - dlon, summit_lat - dlat
        max_lon, max_lat = summit_lon + dlon, summit_lat + dlat
        
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
        
        if window.width < 5 or window.height < 5:
            return []
        
        arr = ds.read(1, window=window, masked=True)
        if arr.count() == 0:
            return []
        
        win_transform = ds.window_transform(window)
        filled = arr.filled(np.nan)
        
        # Compute gradients
        grad_x = sobel(filled, axis=1, mode='constant', cval=np.nan)
        grad_y = sobel(filled, axis=0, mode='constant', cval=np.nan)
        
        # Ridge points have high gradient magnitude but in only one direction
        # (i.e., |grad_x| >> |grad_y| or vice versa)
        grad_mag = np.sqrt(grad_x**2 + grad_y**2)
        
        # Find points with high gradient asymmetry (ridge-like)
        with np.errstate(divide='ignore', invalid='ignore'):
            asymmetry = np.abs(np.abs(grad_x) - np.abs(grad_y)) / (grad_mag + 1e-6)
        
        # Also need to be relatively high elevation
        elev_threshold = float(arr.max()) - 30  # Within 30m of summit
        
        candidates = []
        for r in range(2, arr.shape[0] - 2):
            for c in range(2, arr.shape[1] - 2):
                if arr.mask[r, c]:
                    continue
                if arr[r, c] < elev_threshold:
                    continue
                if asymmetry[r, c] < 0.5:  # Not ridge-like enough
                    continue
                if np.isnan(asymmetry[r, c]):
                    continue
                
                x, y = win_transform * (c + 0.5, r + 0.5)
                if from_native:
                    pt_lon, pt_lat = from_native.transform(x, y)
                else:
                    pt_lon, pt_lat = x, y
                
                # Don't include points too close to summit
                dist = math.sqrt((pt_lat - summit_lat)**2 + (pt_lon - summit_lon)**2) * 111320
                if dist < 20:
                    continue
                
                candidates.append((pt_lat, pt_lon, float(asymmetry[r, c])))
        
        # Sort by asymmetry (most ridge-like first) and take top N
        candidates.sort(key=lambda x: -x[2])
        return [(c[0], c[1]) for c in candidates[:num_points]]


def generate_training_data(
    peaks: List[Dict[str, Any]],
    dem_path: str,
    negatives_per_positive: int = 4,
    feature_radius_m: float = 50.0,
    include_hard_negatives: bool = True,
    verbose: bool = True,
) -> pd.DataFrame:
    """
    Generate training dataset with features.
    
    For each verified peak (positive), generates multiple negative samples
    and extracts features for all points.
    
    If include_hard_negatives=True, also adds:
    - Secondary peaks (nearby local maxima that aren't the true summit)
    - Ridge points (high points with asymmetric gradients)
    """
    rows = []
    feature_names = get_feature_names()
    
    total_peaks = len(peaks)
    total_secondary = 0
    total_ridge = 0
    
    for i, peak in enumerate(peaks):
        peak_id = peak["id"]
        peak_name = peak["name"]
        lat = peak["lat"]
        lon = peak["lon"]
        seed_lat = peak.get("seed_lat", lat)
        seed_lon = peak.get("seed_lon", lon)
        
        if verbose:
            print(f"[{i+1}/{total_peaks}] Processing {peak_name}...")
        
        # === Positive sample (the actual summit) ===
        pos_features = extract_features(
            dem_path, lat, lon, feature_radius_m, seed_lat, seed_lon
        )
        
        if "error" in pos_features:
            if verbose:
                print(f"  WARNING: Error extracting positive features: {pos_features['error']}")
            continue
        
        pos_row = {
            "peak_id": peak_id,
            "peak_name": peak_name,
            "sample_type": "positive",
            "lat": lat,
            "lon": lon,
            "label": 1,
        }
        for fname in feature_names:
            pos_row[fname] = pos_features[fname]
        rows.append(pos_row)
        
        # === Hard negatives: Secondary peaks ===
        if include_hard_negatives:
            try:
                secondary_peaks = find_secondary_peaks(dem_path, lat, lon, radius_m=150.0)
                for sec_lat, sec_lon, sec_elev in secondary_peaks[:2]:  # Max 2 per peak
                    sec_features = extract_features(
                        dem_path, sec_lat, sec_lon, feature_radius_m, seed_lat, seed_lon
                    )
                    if "error" not in sec_features:
                        sec_row = {
                            "peak_id": peak_id,
                            "peak_name": peak_name,
                            "sample_type": "secondary_peak",
                            "lat": sec_lat,
                            "lon": sec_lon,
                            "label": 0,
                        }
                        for fname in feature_names:
                            sec_row[fname] = sec_features[fname]
                        rows.append(sec_row)
                        total_secondary += 1
            except Exception as e:
                if verbose:
                    print(f"  WARNING: Error finding secondary peaks: {e}")
        
        # === Hard negatives: Ridge points ===
        if include_hard_negatives:
            try:
                ridge_points = find_ridge_points(dem_path, lat, lon, radius_m=100.0, num_points=2)
                for ridge_lat, ridge_lon in ridge_points:
                    ridge_features = extract_features(
                        dem_path, ridge_lat, ridge_lon, feature_radius_m, seed_lat, seed_lon
                    )
                    if "error" not in ridge_features:
                        ridge_row = {
                            "peak_id": peak_id,
                            "peak_name": peak_name,
                            "sample_type": "ridge",
                            "lat": ridge_lat,
                            "lon": ridge_lon,
                            "label": 0,
                        }
                        for fname in feature_names:
                            ridge_row[fname] = ridge_features[fname]
                        rows.append(ridge_row)
                        total_ridge += 1
            except Exception as e:
                if verbose:
                    print(f"  WARNING: Error finding ridge points: {e}")
        
        # === Random negatives (easier cases) ===
        neg_count = 0
        attempts = 0
        # Reduce random negatives if we have hard negatives
        random_negatives_target = negatives_per_positive - 2 if include_hard_negatives else negatives_per_positive
        max_attempts = random_negatives_target * 3
        
        while neg_count < random_negatives_target and attempts < max_attempts:
            attempts += 1
            
            neg_lat, neg_lon = generate_negative_sample(lat, lon)
            
            neg_features = extract_features(
                dem_path, neg_lat, neg_lon, feature_radius_m, seed_lat, seed_lon
            )
            
            if "error" in neg_features:
                continue  # Skip invalid points
            
            # Skip if this point is actually very high (might be another summit)
            if neg_features["elev_rank"] > 0.95 and neg_features["pct_lower"] > 0.9:
                continue  # Too summit-like, skip
            
            neg_row = {
                "peak_id": peak_id,
                "peak_name": peak_name,
                "sample_type": "random",
                "lat": neg_lat,
                "lon": neg_lon,
                "label": 0,
            }
            for fname in feature_names:
                neg_row[fname] = neg_features[fname]
            rows.append(neg_row)
            neg_count += 1
        
        if verbose and neg_count < random_negatives_target:
            print(f"  WARNING: Only generated {neg_count}/{random_negatives_target} random negatives")
    
    if verbose and include_hard_negatives:
        print(f"\nHard negatives added:")
        print(f"  Secondary peaks: {total_secondary}")
        print(f"  Ridge points: {total_ridge}")
    
    df = pd.DataFrame(rows)
    return df


def main():
    parser = argparse.ArgumentParser(description="Generate ML training data for summit detection")
    parser.add_argument("--dem-path", required=True, help="Path to DEM file (GeoTIFF or VRT)")
    parser.add_argument("--output", default="training_data.csv", help="Output CSV path")
    parser.add_argument("--min-elevation-14er", type=float, default=4267.0, 
                        help="Minimum elevation (m) for 14ers (default: 4267)")
    parser.add_argument("--max-snap-distance-13er", type=float, default=8.0,
                        help="Max snap distance (m) for verified 13ers (default: 8)")
    parser.add_argument("--negatives-per-positive", type=int, default=4,
                        help="Number of negative samples per positive (default: 4)")
    parser.add_argument("--feature-radius", type=float, default=50.0,
                        help="Radius (m) for feature extraction (default: 50)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--quiet", action="store_true", help="Suppress verbose output")
    parser.add_argument("--no-hard-negatives", action="store_true", 
                        help="Disable hard negatives (secondary peaks, ridge points)")
    
    args = parser.parse_args()
    
    random.seed(args.seed)
    np.random.seed(args.seed)
    
    print("=" * 60)
    print("GENERATE ML TRAINING DATA FOR SUMMIT DETECTION")
    print("=" * 60)
    print(f"DEM path: {args.dem_path}")
    print(f"Output: {args.output}")
    print(f"14er threshold: >= {args.min_elevation_14er}m")
    print(f"13er snap distance: < {args.max_snap_distance_13er}m")
    print(f"Negatives per positive: {args.negatives_per_positive}")
    print(f"Feature radius: {args.feature_radius}m")
    print()
    
    # Connect to database
    print("Connecting to database...")
    conn = get_db_connection()
    
    # Fetch verified peaks
    print("Fetching verified peaks...")
    peaks = fetch_verified_peaks(
        conn,
        min_elevation_14er=args.min_elevation_14er,
        max_snap_distance_13er=args.max_snap_distance_13er,
    )
    conn.close()
    
    num_14ers = sum(1 for p in peaks if p["elevation"] >= args.min_elevation_14er)
    num_13ers = len(peaks) - num_14ers
    
    print(f"Found {len(peaks)} verified peaks:")
    print(f"  - 14ers: {num_14ers}")
    print(f"  - Verified 13ers: {num_13ers}")
    print()
    
    if len(peaks) == 0:
        print("ERROR: No verified peaks found!")
        sys.exit(1)
    
    # Generate training data
    include_hard_negatives = not args.no_hard_negatives
    print(f"Hard negatives (secondary peaks, ridges): {'YES' if include_hard_negatives else 'NO'}")
    print("Generating training data...")
    print("-" * 60)
    
    df = generate_training_data(
        peaks,
        args.dem_path,
        negatives_per_positive=args.negatives_per_positive,
        feature_radius_m=args.feature_radius,
        include_hard_negatives=include_hard_negatives,
        verbose=not args.quiet,
    )
    
    # Save to CSV
    print("-" * 60)
    print(f"Saving to {args.output}...")
    df.to_csv(args.output, index=False)
    
    # Summary
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Total samples: {len(df)}")
    print(f"  - Positive (summits): {(df['label'] == 1).sum()}")
    print(f"  - Negative (non-summits): {(df['label'] == 0).sum()}")
    
    # Breakdown by sample type
    if 'sample_type' in df.columns:
        print("\nSample type breakdown:")
        for stype in df['sample_type'].unique():
            count = (df['sample_type'] == stype).sum()
            print(f"  - {stype}: {count}")
    
    print()
    print(f"Features: {len(get_feature_names())}")
    for fname in get_feature_names():
        print(f"  - {fname}")
    print()
    print(f"Output saved to: {args.output}")


if __name__ == "__main__":
    main()

