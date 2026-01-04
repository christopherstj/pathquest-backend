import argparse
import json
import math
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import rasterio
from pyproj import Transformer
from scipy.ndimage import maximum_filter, gaussian_filter


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2.0) ** 2
    return 2.0 * r * math.asin(math.sqrt(a))


def deg_window_from_radius(lat: float, radius_m: float) -> Tuple[float, float]:
    # Approx conversions; good enough for <= few km windows.
    deg_lat = radius_m / 111320.0
    deg_lon = radius_m / (111320.0 * max(0.1, math.cos(math.radians(lat))))
    return deg_lat, deg_lon


def iter_jsonl(f) -> Iterable[Dict[str, Any]]:
    for line in f:
        line = line.strip()
        if not line:
            continue
        yield json.loads(line)


def find_local_maxima_scipy(
    arr: np.ndarray,
    valid_mask: np.ndarray,
    neighborhood_size: int = 5,
    gaussian_sigma: float = 0.0,
) -> np.ndarray:
    """
    Find local maxima using scipy's maximum_filter.
    """
    work_arr = arr.copy()
    
    if np.ma.is_masked(work_arr):
        work_arr = work_arr.filled(np.nan)
    
    work_arr[~valid_mask] = -np.inf
    
    if gaussian_sigma > 0:
        smoothed = gaussian_filter(np.where(valid_mask, work_arr, 0), sigma=gaussian_sigma)
        mask_smoothed = gaussian_filter(valid_mask.astype(float), sigma=gaussian_sigma)
        mask_smoothed = np.maximum(mask_smoothed, 1e-10)
        work_arr = np.where(valid_mask, smoothed / mask_smoothed, -np.inf)
    
    local_max_vals = maximum_filter(work_arr, size=neighborhood_size, mode='constant', cval=-np.inf)
    is_local_max = (work_arr == local_max_vals) & valid_mask & (work_arr > -np.inf)
    
    return is_local_max


def compute_radial_dominance(
    arr: np.ndarray,
    valid_mask: np.ndarray,
    r_off: int,
    c_off: int,
    sample_distance_pixels: int = 10,
) -> float:
    """
    Check how many of 8 cardinal/diagonal directions are going downhill from the candidate.
    
    Returns a score from 0.0 to 1.0:
    - 1.0 = all 8 directions going downhill (perfect summit)
    - 0.5 = 4 directions going downhill (ridge point)
    - 0.0 = no directions going downhill (depression or flat)
    """
    center_elev = float(arr[r_off, c_off])
    
    # 8 directions: N, NE, E, SE, S, SW, W, NW
    directions = [
        (-1, 0), (-1, 1), (0, 1), (1, 1),
        (1, 0), (1, -1), (0, -1), (-1, -1)
    ]
    
    downhill_count = 0
    valid_directions = 0
    
    for dr, dc in directions:
        sample_r = r_off + dr * sample_distance_pixels
        sample_c = c_off + dc * sample_distance_pixels
        
        # Check bounds
        if sample_r < 0 or sample_r >= arr.shape[0]:
            continue
        if sample_c < 0 or sample_c >= arr.shape[1]:
            continue
        if not valid_mask[sample_r, sample_c]:
            continue
        
        valid_directions += 1
        sample_elev = float(arr[sample_r, sample_c])
        
        if sample_elev < center_elev:
            downhill_count += 1
    
    if valid_directions == 0:
        return 0.5  # Can't determine, neutral score
    
    return downhill_count / valid_directions


def compute_neighborhood_dominance(
    arr: np.ndarray,
    valid_mask: np.ndarray,
    r_off: int,
    c_off: int,
    radius_pixels: int = 15,
) -> float:
    """
    Check what percentage of cells within a radius are lower than the candidate.
    
    Returns a score from 0.0 to 1.0:
    - 1.0 = all cells in radius are lower (dominant peak)
    - 0.5 = half the cells are lower (not a clear peak)
    """
    center_elev = float(arr[r_off, c_off])
    
    # Define window bounds
    r_min = max(0, r_off - radius_pixels)
    r_max = min(arr.shape[0], r_off + radius_pixels + 1)
    c_min = max(0, c_off - radius_pixels)
    c_max = min(arr.shape[1], c_off + radius_pixels + 1)
    
    # Extract neighborhood
    neighborhood = arr[r_min:r_max, c_min:c_max]
    neighborhood_valid = valid_mask[r_min:r_max, c_min:c_max]
    
    # Count valid cells that are strictly lower
    valid_cells = neighborhood[neighborhood_valid]
    if len(valid_cells) <= 1:
        return 0.5  # Can't determine
    
    # Exclude the center cell from comparison
    lower_count = np.sum(valid_cells < center_elev)
    total_valid = len(valid_cells) - 1  # Exclude center
    
    if total_valid <= 0:
        return 0.5
    
    return lower_count / total_valid


def compute_summit_confidence(
    arr: np.ndarray,
    valid_mask: np.ndarray,
    r_off: int,
    c_off: int,
    radial_distance_pixels: int = 10,
    neighborhood_radius_pixels: int = 15,
) -> Tuple[float, float, float]:
    """
    Compute a summit confidence score combining radial and neighborhood dominance.
    
    Returns: (combined_score, radial_score, neighborhood_score)
    """
    radial_score = compute_radial_dominance(
        arr, valid_mask, r_off, c_off, radial_distance_pixels
    )
    
    neighborhood_score = compute_neighborhood_dominance(
        arr, valid_mask, r_off, c_off, neighborhood_radius_pixels
    )
    
    # Combined score: weighted average (radial is more important for identifying true summits)
    combined = 0.6 * radial_score + 0.4 * neighborhood_score
    
    return combined, radial_score, neighborhood_score


def snap_one_top_k(
    ds: rasterio.io.DatasetReader,
    lon: float,
    lat: float,
    radius_m: float,
    top_k: int,
    min_separation_m: float,
    to_wgs84: Optional[Transformer],
    from_wgs84: Optional[Transformer],
    require_local_max: bool = True,
    neighborhood_size: int = 5,
    gaussian_sigma: float = 0.0,
    prefer_nearest: bool = True,
    compute_confidence: bool = True,
    confidence_radial_m: float = 20.0,
    confidence_neighborhood_m: float = 30.0,
) -> List[Dict[str, Any]]:
    """
    Find the top K highest points within radius_m of (lat, lon), 
    with summit confidence scoring.
    """
    if ds.crs is None:
        raise RuntimeError("DEM dataset has no CRS")

    # Get pixel size for confidence calculations
    pixel_size_m = 1.0  # Default for geographic CRS
    if not ds.crs.is_geographic:
        # For projected CRS, pixel size is in the CRS units (usually meters)
        pixel_size_m = abs(ds.transform.a)  # X resolution
    else:
        # For geographic, approximate at this latitude
        pixel_size_m = abs(ds.transform.a) * 111320.0 * math.cos(math.radians(lat))

    if ds.crs.is_geographic:
        deg_lat, deg_lon = deg_window_from_radius(lat, radius_m)
        min_lon = lon - deg_lon
        max_lon = lon + deg_lon
        min_lat = lat - deg_lat
        max_lat = lat + deg_lat
        row_min, col_min = ds.index(min_lon, max_lat)
        row_max, col_max = ds.index(max_lon, min_lat)
    else:
        if from_wgs84 is None:
            raise RuntimeError("Missing from_wgs84 transformer for projected dataset")
        x, y = from_wgs84.transform(lon, lat)
        min_x = x - radius_m
        max_x = x + radius_m
        min_y = y - radius_m
        max_y = y + radius_m
        row_min, col_min = ds.index(min_x, max_y)
        row_max, col_max = ds.index(max_x, min_y)

    row0 = max(0, min(row_min, row_max))
    row1 = min(ds.height - 1, max(row_min, row_max))
    col0 = max(0, min(col_min, col_max))
    col1 = min(ds.width - 1, max(col_min, col_max))

    if row1 <= row0 or col1 <= col0:
        return []

    window = rasterio.windows.Window.from_slices((row0, row1 + 1), (col0, col1 + 1))
    arr = ds.read(1, window=window, masked=True)
    if arr.size == 0:
        return []

    if np.ma.is_masked(arr):
        if arr.mask.all():
            return []

    if np.ma.is_masked(arr):
        valid_mask = ~arr.mask
    else:
        valid_mask = np.ones(arr.shape, dtype=bool)
    
    if require_local_max:
        local_max_mask = find_local_maxima_scipy(arr, valid_mask, neighborhood_size, gaussian_sigma)
        candidate_mask = local_max_mask
    else:
        candidate_mask = valid_mask
    
    candidate_indices = np.where(candidate_mask)
    if len(candidate_indices[0]) == 0:
        return []
    
    # Convert confidence distances to pixels
    radial_pixels = max(1, int(confidence_radial_m / pixel_size_m))
    neighborhood_pixels = max(1, int(confidence_neighborhood_m / pixel_size_m))
    
    candidates_data = []
    for r_off, c_off in zip(candidate_indices[0], candidate_indices[1]):
        r = int(row0 + r_off)
        c = int(col0 + c_off)
        
        x, y = ds.xy(r, c)
        if ds.crs.is_geographic:
            cand_lon = float(x)
            cand_lat = float(y)
        else:
            if to_wgs84 is None:
                raise RuntimeError("Missing to_wgs84 transformer for projected dataset")
            cand_lon, cand_lat = to_wgs84.transform(x, y)
            cand_lon = float(cand_lon)
            cand_lat = float(cand_lat)
        
        elev = float(arr[r_off, c_off])
        dist_from_seed = haversine_m(lat, lon, cand_lat, cand_lon)
        
        # Compute confidence scores
        if compute_confidence:
            confidence, radial_score, neighborhood_score = compute_summit_confidence(
                arr, valid_mask, r_off, c_off, radial_pixels, neighborhood_pixels
            )
        else:
            confidence = 1.0
            radial_score = 1.0
            neighborhood_score = 1.0
        
        candidates_data.append({
            "snapped_lat": cand_lat,
            "snapped_lon": cand_lon,
            "elevation_m": elev,
            "snapped_distance_m": dist_from_seed,
            "confidence": round(confidence, 3),
            "radial_score": round(radial_score, 3),
            "neighborhood_score": round(neighborhood_score, 3),
        })
    
    # Sort candidates by: confidence desc, then elevation desc, then distance asc
    if prefer_nearest:
        def sort_key(c):
            # Primary: confidence (desc), Secondary: elevation bin (desc), Tertiary: distance (asc)
            conf_bin = -int(c["confidence"] * 10)  # 0.1 bins
            elev_bin = -int(c["elevation_m"] / 2.0)  # 2m bins
            return (conf_bin, elev_bin, c["snapped_distance_m"])
        candidates_data.sort(key=sort_key)
    else:
        candidates_data.sort(key=lambda c: (-c["confidence"], -c["elevation_m"]))
    
    # Select top K with minimum separation
    selected: List[Dict[str, Any]] = []
    
    for cand in candidates_data:
        if len(selected) >= top_k:
            break
        
        too_close = False
        for existing in selected:
            sep = haversine_m(cand["snapped_lat"], cand["snapped_lon"], 
                            existing["snapped_lat"], existing["snapped_lon"])
            if sep < min_separation_m:
                too_close = True
                break
        
        if not too_close:
            selected.append(cand)
    
    return selected


def snap_one(
    ds: rasterio.io.DatasetReader,
    lon: float,
    lat: float,
    radius_m: float,
    to_wgs84: Optional[Transformer],
    from_wgs84: Optional[Transformer],
    require_local_max: bool = True,
) -> Optional[Dict[str, Any]]:
    candidates = snap_one_top_k(ds, lon, lat, radius_m, 1, 0.0, to_wgs84, from_wgs84, require_local_max)
    return candidates[0] if candidates else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", required=True, help="Path to DEM GeoTIFF/COG or VRT")
    parser.add_argument("--default-radius-m", type=float, default=250.0)
    parser.add_argument("--default-top-k", type=int, default=1)
    parser.add_argument("--default-min-separation-m", type=float, default=30.0)
    parser.add_argument("--no-require-local-max", action="store_true")
    parser.add_argument("--neighborhood-size", type=int, default=5)
    parser.add_argument("--gaussian-sigma", type=float, default=1.0)
    parser.add_argument("--no-prefer-nearest", action="store_true")
    parser.add_argument("--no-compute-confidence", action="store_true")
    parser.add_argument("--confidence-radial-m", type=float, default=20.0, 
                       help="Distance in meters for radial dominance check")
    parser.add_argument("--confidence-neighborhood-m", type=float, default=30.0,
                       help="Radius in meters for neighborhood dominance check")
    args = parser.parse_args()
    
    default_require_local_max = not args.no_require_local_max
    default_prefer_nearest = not args.no_prefer_nearest
    default_compute_confidence = not args.no_compute_confidence

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
                top_k = int(rec.get("top_k", args.default_top_k))
                min_separation_m = float(rec.get("min_separation_m", args.default_min_separation_m))
                require_local_max = rec.get("require_local_max", default_require_local_max)
                neighborhood_size = int(rec.get("neighborhood_size", args.neighborhood_size))
                gaussian_sigma = float(rec.get("gaussian_sigma", args.gaussian_sigma))
                prefer_nearest = rec.get("prefer_nearest", default_prefer_nearest)
                compute_confidence = rec.get("compute_confidence", default_compute_confidence)
                confidence_radial_m = float(rec.get("confidence_radial_m", args.confidence_radial_m))
                confidence_neighborhood_m = float(rec.get("confidence_neighborhood_m", args.confidence_neighborhood_m))

                candidates = snap_one_top_k(
                    ds, lon=lon, lat=lat, radius_m=radius_m,
                    top_k=top_k, min_separation_m=min_separation_m,
                    to_wgs84=to_wgs84, from_wgs84=from_wgs84,
                    require_local_max=require_local_max,
                    neighborhood_size=neighborhood_size,
                    gaussian_sigma=gaussian_sigma,
                    prefer_nearest=prefer_nearest,
                    compute_confidence=compute_confidence,
                    confidence_radial_m=confidence_radial_m,
                    confidence_neighborhood_m=confidence_neighborhood_m,
                )
                
                if not candidates:
                    sys.stdout.write(json.dumps({"peak_id": peak_id, "error": "no_local_max"}) + "\n")
                    continue

                out = {
                    "peak_id": peak_id,
                    "candidates": candidates,
                }
                sys.stdout.write(json.dumps(out) + "\n")
            except Exception as e:
                sys.stdout.write(json.dumps({"peak_id": rec.get("peak_id"), "error": str(e)}) + "\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
