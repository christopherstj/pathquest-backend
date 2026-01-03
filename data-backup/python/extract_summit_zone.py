import argparse
import json
import math
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import rasterio
from rasterio import features
from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import unary_union


def deg_window_from_radius(lat: float, radius_m: float) -> Tuple[float, float]:
    """Approximate conversion from meters to degrees at given latitude."""
    deg_lat = radius_m / 111320.0
    deg_lon = radius_m / (111320.0 * max(0.1, math.cos(math.radians(lat))))
    return deg_lat, deg_lon


def iter_jsonl(f) -> Iterable[Dict[str, Any]]:
    for line in f:
        line = line.strip()
        if not line:
            continue
        yield json.loads(line)


def compute_area_sq_m(geom, centroid_lat: float) -> float:
    """
    Approximate area in square meters for a geometry in EPSG:4326.
    Uses a local UTM-like projection centered on the geometry.
    """
    # Simple approximation: convert to meters using latitude
    # More accurate would be to use pyproj to transform to a local projection
    # but for small summit zones this is good enough
    if geom.is_empty:
        return 0.0
    
    # Use approximate meters per degree at the centroid latitude
    m_per_deg_lat = 111320.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(centroid_lat))
    
    # Scale factor for area (lat * lon)
    area_scale = m_per_deg_lat * m_per_deg_lon
    
    return geom.area * area_scale


def count_vertices(geom) -> int:
    """Count total vertices in a geometry."""
    if geom.is_empty:
        return 0
    if hasattr(geom, 'exterior'):
        # Polygon
        count = len(geom.exterior.coords)
        for interior in geom.interiors:
            count += len(interior.coords)
        return count
    elif hasattr(geom, 'geoms'):
        # Multi* geometry
        return sum(count_vertices(g) for g in geom.geoms)
    elif hasattr(geom, 'coords'):
        # LineString, Point
        return len(geom.coords)
    return 0


def extract_summit_zone(
    ds: rasterio.io.DatasetReader,
    lon: float,
    lat: float,
    radius_m: float,
    threshold_m: float,
    to_wgs84: Optional[Transformer],
    from_wgs84: Optional[Transformer],
) -> Optional[Dict[str, Any]]:
    """
    Extract a polygon representing all DEM cells within threshold_m vertical meters
    of the maximum elevation within radius_m of (lat, lon).
    """
    if ds.crs is None:
        raise RuntimeError("DEM dataset has no CRS")

    # Calculate window bounds
    if ds.crs.is_geographic:
        deg_lat, deg_lon = deg_window_from_radius(lat, radius_m)
        min_lon = lon - deg_lon
        max_lon = lon + deg_lon
        min_lat = lat - deg_lat
        max_lat = lat + deg_lat
        row_min, col_min = ds.index(min_lon, max_lat)  # top-left
        row_max, col_max = ds.index(max_lon, min_lat)  # bottom-right
    else:
        if from_wgs84 is None:
            raise RuntimeError("Missing from_wgs84 transformer for projected dataset")
        x, y = from_wgs84.transform(lon, lat)
        min_x = x - radius_m
        max_x = x + radius_m
        min_y = y - radius_m
        max_y = y + radius_m
        row_min, col_min = ds.index(min_x, max_y)  # top-left
        row_max, col_max = ds.index(max_x, min_y)  # bottom-right

    # Normalize window bounds
    row0 = max(0, min(row_min, row_max))
    row1 = min(ds.height - 1, max(row_min, row_max))
    col0 = max(0, min(col_min, col_max))
    col1 = min(ds.width - 1, max(col_min, col_max))

    if row1 <= row0 or col1 <= col0:
        return None

    window = rasterio.windows.Window.from_slices((row0, row1 + 1), (col0, col1 + 1))
    arr = ds.read(1, window=window, masked=True)
    
    if arr.size == 0:
        return None

    if np.ma.is_masked(arr):
        if arr.mask.all():
            return None

    # Find max elevation
    max_elev = float(arr.max())
    
    # Create binary mask: cells >= (max_elev - threshold_m)
    threshold_elev = max_elev - threshold_m
    zone_mask = (arr >= threshold_elev).astype(np.uint8)
    
    # Handle masked arrays
    if np.ma.is_masked(arr):
        zone_mask = np.where(arr.mask, 0, zone_mask)
    
    # Get the transform for this window
    window_transform = ds.window_transform(window)
    
    # Convert mask to polygon(s)
    shapes_gen = features.shapes(zone_mask, mask=(zone_mask == 1), transform=window_transform)
    
    polygons = []
    for geom_dict, value in shapes_gen:
        if value == 1:
            geom = shape(geom_dict)
            
            # Transform to WGS84 if needed
            if not ds.crs.is_geographic and to_wgs84 is not None:
                # Transform polygon coordinates
                from shapely.ops import transform as shapely_transform
                geom = shapely_transform(
                    lambda x, y: to_wgs84.transform(x, y),
                    geom
                )
            
            polygons.append(geom)
    
    if not polygons:
        return None
    
    # Union all polygons into one geometry
    if len(polygons) == 1:
        zone_geom = polygons[0]
    else:
        zone_geom = unary_union(polygons)
    
    # Calculate area and vertex count
    centroid = zone_geom.centroid
    area_sq_m = compute_area_sq_m(zone_geom, centroid.y)
    vertices = count_vertices(zone_geom)
    
    # Convert to WKT
    zone_wkt = zone_geom.wkt
    
    return {
        "zone_wkt": zone_wkt,
        "area_sq_m": area_sq_m,
        "max_elevation_m": max_elev,
        "threshold_m": threshold_m,
        "vertices": vertices,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract summit zone polygons from DEM")
    parser.add_argument("--dem", required=True, help="Path to DEM GeoTIFF/COG or VRT")
    parser.add_argument("--default-radius-m", type=float, default=250.0)
    parser.add_argument("--default-threshold-m", type=float, default=5.0)
    args = parser.parse_args()

    # Check for shapely
    try:
        from shapely.geometry import shape
    except ImportError:
        sys.stderr.write("Error: shapely is required. Install with: pip install shapely\n")
        return 1

    with rasterio.open(args.dem) as ds:
        to_wgs84 = None
        from_wgs84 = None

        if ds.crs is not None and not ds.crs.is_geographic:
            to_wgs84 = Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True)
            from_wgs84 = Transformer.from_crs("EPSG:4326", ds.crs, always_xy=True)

        for rec in iter_jsonl(sys.stdin):
            try:
                peak_id = rec.get("peak_id")
                lat = float(rec["lat"])
                lon = float(rec["lon"])
                radius_m = float(rec.get("radius_m", args.default_radius_m))
                threshold_m = float(rec.get("threshold_m", args.default_threshold_m))

                result = extract_summit_zone(
                    ds, lon=lon, lat=lat, radius_m=radius_m, threshold_m=threshold_m,
                    to_wgs84=to_wgs84, from_wgs84=from_wgs84
                )
                
                if result is None:
                    sys.stdout.write(json.dumps({"peak_id": peak_id, "error": "no_data"}) + "\n")
                    continue

                result["peak_id"] = peak_id
                sys.stdout.write(json.dumps(result) + "\n")
            except Exception as e:
                sys.stdout.write(json.dumps({"peak_id": rec.get("peak_id"), "error": str(e)}) + "\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

