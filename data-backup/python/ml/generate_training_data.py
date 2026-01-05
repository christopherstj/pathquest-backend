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


def generate_training_data(
    peaks: List[Dict[str, Any]],
    dem_path: str,
    negatives_per_positive: int = 4,
    feature_radius_m: float = 50.0,
    verbose: bool = True,
) -> pd.DataFrame:
    """
    Generate training dataset with features.
    
    For each verified peak (positive), generates multiple negative samples
    and extracts features for all points.
    """
    rows = []
    feature_names = get_feature_names()
    
    total_peaks = len(peaks)
    
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
        
        # === Negative samples (random points away from summit) ===
        neg_count = 0
        attempts = 0
        max_attempts = negatives_per_positive * 3
        
        while neg_count < negatives_per_positive and attempts < max_attempts:
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
                "sample_type": "negative",
                "lat": neg_lat,
                "lon": neg_lon,
                "label": 0,
            }
            for fname in feature_names:
                neg_row[fname] = neg_features[fname]
            rows.append(neg_row)
            neg_count += 1
        
        if verbose and neg_count < negatives_per_positive:
            print(f"  WARNING: Only generated {neg_count}/{negatives_per_positive} negatives")
    
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
    print("Generating training data...")
    print("-" * 60)
    
    df = generate_training_data(
        peaks,
        args.dem_path,
        negatives_per_positive=args.negatives_per_positive,
        feature_radius_m=args.feature_radius,
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
    print()
    print(f"Features: {len(get_feature_names())}")
    for fname in get_feature_names():
        print(f"  - {fname}")
    print()
    print(f"Output saved to: {args.output}")


if __name__ == "__main__":
    main()

