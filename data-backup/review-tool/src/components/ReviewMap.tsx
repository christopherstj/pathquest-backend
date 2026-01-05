"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { ReviewPeak } from "@/lib/db";

export interface CustomCoords {
    lat: number;
    lon: number;
}

interface ReviewMapProps {
    peak: ReviewPeak | null;
    mapboxToken: string;
    pickingMode?: boolean;
    customCoords?: CustomCoords | null;
    onPick?: (coords: CustomCoords) => void;
}

export function ReviewMap({
    peak,
    mapboxToken,
    pickingMode = false,
    customCoords,
    onPick,
}: ReviewMapProps) {
    const mapContainer = useRef<HTMLDivElement>(null);
    const map = useRef<mapboxgl.Map | null>(null);
    const seedMarker = useRef<mapboxgl.Marker | null>(null);
    const snappedMarker = useRef<mapboxgl.Marker | null>(null);
    const customMarker = useRef<mapboxgl.Marker | null>(null);
    const [mapLoaded, setMapLoaded] = useState(false);

    // Handle map clicks for picking mode
    const handleMapClick = useCallback(
        (e: mapboxgl.MapMouseEvent) => {
            if (!pickingMode || !onPick) return;
            onPick({
                lat: e.lngLat.lat,
                lon: e.lngLat.lng,
            });
        },
        [pickingMode, onPick]
    );

    // Initialize map
    useEffect(() => {
        if (!mapContainer.current || map.current) return;

        mapboxgl.accessToken = mapboxToken;

        map.current = new mapboxgl.Map({
            container: mapContainer.current,
            style: "mapbox://styles/mapbox/outdoors-v12",
            center: [-105.5, 39.5],
            zoom: 10,
            pitch: 60,
            bearing: 0,
        });

        map.current.on("load", () => {
            if (!map.current) return;

            map.current.addSource("mapbox-dem", {
                type: "raster-dem",
                url: "mapbox://mapbox.mapbox-terrain-dem-v1",
                tileSize: 512,
                maxzoom: 14,
            });

            map.current.setTerrain({
                source: "mapbox-dem",
                exaggeration: 1.5,
            });

            map.current.addLayer({
                id: "sky",
                type: "sky",
                paint: {
                    "sky-type": "atmosphere",
                    "sky-atmosphere-sun": [0.0, 90.0],
                    "sky-atmosphere-sun-intensity": 15,
                },
            });

            setMapLoaded(true);
        });

        map.current.addControl(
            new mapboxgl.NavigationControl({ visualizePitch: true }),
            "top-right"
        );

        return () => {
            if (map.current) {
                map.current.remove();
                map.current = null;
            }
        };
    }, [mapboxToken]);

    // Handle picking mode cursor and click
    useEffect(() => {
        if (!map.current || !mapLoaded) return;

        if (pickingMode) {
            map.current.getCanvas().style.cursor = "crosshair";
            map.current.on("click", handleMapClick);
        } else {
            map.current.getCanvas().style.cursor = "";
            map.current.off("click", handleMapClick);
        }

        return () => {
            if (map.current) {
                map.current.off("click", handleMapClick);
            }
        };
    }, [pickingMode, mapLoaded, handleMapClick]);

    // Update custom marker
    useEffect(() => {
        if (!map.current || !mapLoaded) return;

        // Remove existing custom marker
        if (customMarker.current) {
            customMarker.current.remove();
            customMarker.current = null;
        }

        if (!customCoords) return;

        // Create custom marker (blue/purple)
        const customEl = document.createElement("div");
        customEl.innerHTML = `
            <div style="
                position: relative;
                width: 24px;
                height: 24px;
            ">
                <div style="
                    position: absolute;
                    inset: 0;
                    background: rgba(147, 51, 234, 0.2);
                    border-radius: 50%;
                    animation: pulse-custom 1.5s ease-in-out infinite;
                "></div>
                <div style="
                    position: absolute;
                    inset: 2px;
                    background: linear-gradient(180deg, #a855f7 0%, #7c3aed 100%);
                    border: 3px solid white;
                    border-radius: 50%;
                    box-shadow: 0 2px 12px rgba(147, 51, 234, 0.5), 0 0 0 1px rgba(0,0,0,0.1);
                    cursor: pointer;
                "></div>
            </div>
            <style>
                @keyframes pulse-custom {
                    0%, 100% { transform: scale(1); opacity: 1; }
                    50% { transform: scale(1.6); opacity: 0; }
                }
            </style>
        `;

        customMarker.current = new mapboxgl.Marker({
            element: customEl,
            anchor: "center",
        })
            .setLngLat([customCoords.lon, customCoords.lat])
            .setPopup(
                new mapboxgl.Popup({
                    offset: 15,
                    closeButton: false,
                }).setHTML(`
                    <div style="font-family: var(--font-mono);">
                        <div style="font-weight: 600; color: #7c3aed; margin-bottom: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Custom Location</div>
                        <div style="font-size: 12px;">
                            <span style="color: #666;">LAT</span> ${customCoords.lat.toFixed(6)}°<br/>
                            <span style="color: #666;">LON</span> ${customCoords.lon.toFixed(6)}°
                        </div>
                    </div>
                `)
            )
            .addTo(map.current);
    }, [customCoords, mapLoaded]);

    // Update markers and fly to peak when peak changes
    useEffect(() => {
        if (!map.current || !mapLoaded || !peak) return;

        // Remove existing markers
        if (seedMarker.current) {
            seedMarker.current.remove();
            seedMarker.current = null;
        }
        if (snappedMarker.current) {
            snappedMarker.current.remove();
            snappedMarker.current = null;
        }

        // Remove existing line layer
        if (map.current.getLayer("connection-line")) {
            map.current.removeLayer("connection-line");
        }
        if (map.current.getSource("connection-line")) {
            map.current.removeSource("connection-line");
        }

        // Create seed marker (red for snapped peaks, amber for flagged-only peaks)
        const isSnapped = peak.has_snapped && peak.snapped_lat != null && peak.snapped_lon != null;
        const seedColor = isSnapped ? "#ef4444" : "#f59e0b"; // red vs amber
        const seedEl = document.createElement("div");
        seedEl.innerHTML = `
            <div style="
                width: ${isSnapped ? "14px" : "20px"};
                height: ${isSnapped ? "14px" : "20px"};
                background: linear-gradient(180deg, ${seedColor} 0%, ${isSnapped ? "#dc2626" : "#d97706"} 100%);
                border: ${isSnapped ? "2px" : "3px"} solid white;
                border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.1);
                cursor: pointer;
            "></div>
        `;

        seedMarker.current = new mapboxgl.Marker({
            element: seedEl,
            anchor: "center",
        })
            .setLngLat([peak.seed_lon, peak.seed_lat])
            .setPopup(
                new mapboxgl.Popup({
                    offset: 15,
                    closeButton: false,
                }).setHTML(`
                    <div style="font-family: var(--font-mono);">
                        <div style="font-weight: 600; color: ${isSnapped ? "#dc2626" : "#d97706"}; margin-bottom: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">${isSnapped ? "Original" : "Current"} Location</div>
                        <div style="font-size: 12px;">
                            <span style="color: #666;">LAT</span> ${peak.seed_lat.toFixed(6)}°<br/>
                            <span style="color: #666;">LON</span> ${peak.seed_lon.toFixed(6)}°
                            ${peak.elevation != null ? `<br/><span style="color: #666;">ELEV</span> ${peak.elevation.toFixed(1)}m` : ""}
                        </div>
                    </div>
                `)
            )
            .addTo(map.current);

        // Only create snapped marker and line if peak has been snapped
        if (isSnapped) {
            // Create snapped marker (green)
            const snappedEl = document.createElement("div");
            snappedEl.innerHTML = `
                <div style="
                    position: relative;
                    width: 22px;
                    height: 22px;
                ">
                    <div style="
                        position: absolute;
                        inset: 0;
                        background: rgba(16, 185, 129, 0.2);
                        border-radius: 50%;
                        animation: pulse 2s ease-in-out infinite;
                    "></div>
                    <div style="
                        position: absolute;
                        inset: 3px;
                        background: linear-gradient(180deg, #10b981 0%, #059669 100%);
                        border: 3px solid white;
                        border-radius: 50%;
                        box-shadow: 0 2px 12px rgba(16, 185, 129, 0.4), 0 0 0 1px rgba(0,0,0,0.1);
                        cursor: pointer;
                    "></div>
                </div>
                <style>
                    @keyframes pulse {
                        0%, 100% { transform: scale(1); opacity: 1; }
                        50% { transform: scale(1.5); opacity: 0; }
                    }
                </style>
            `;

            snappedMarker.current = new mapboxgl.Marker({
                element: snappedEl,
                anchor: "center",
            })
                .setLngLat([peak.snapped_lon!, peak.snapped_lat!])
                .setPopup(
                    new mapboxgl.Popup({
                        offset: 15,
                        closeButton: false,
                    }).setHTML(`
                        <div style="font-family: var(--font-mono);">
                            <div style="font-weight: 600; color: #059669; margin-bottom: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Proposed Location</div>
                            <div style="font-size: 12px;">
                                <span style="color: #666;">LAT</span> ${peak.snapped_lat!.toFixed(6)}°<br/>
                                <span style="color: #666;">LON</span> ${peak.snapped_lon!.toFixed(6)}°
                                ${peak.snapped_elevation_m != null ? `<br/><span style="color: #666;">ELEV</span> ${peak.snapped_elevation_m.toFixed(1)}m` : ""}
                            </div>
                        </div>
                    `)
                )
                .addTo(map.current);

            // Add line connecting the two points
            map.current.addSource("connection-line", {
                type: "geojson",
                data: {
                    type: "Feature",
                    properties: {},
                    geometry: {
                        type: "LineString",
                        coordinates: [
                            [peak.seed_lon, peak.seed_lat],
                            [peak.snapped_lon!, peak.snapped_lat!],
                        ],
                    },
                },
            });

            map.current.addLayer({
                id: "connection-line",
                type: "line",
                source: "connection-line",
                layout: {
                    "line-join": "round",
                    "line-cap": "round",
                },
                paint: {
                    "line-color": "#3b82f6",
                    "line-width": 3,
                    "line-dasharray": [3, 3],
                    "line-opacity": 0.8,
                },
            });
        }

        // Calculate center and zoom
        const centerLat = isSnapped 
            ? (peak.seed_lat + peak.snapped_lat!) / 2 
            : peak.seed_lat;
        const centerLon = isSnapped 
            ? (peak.seed_lon + peak.snapped_lon!) / 2 
            : peak.seed_lon;
        const distM = peak.snapped_distance_m ?? 50;
        const zoom = isSnapped 
            ? (distM < 20 ? 18 : distM < 50 ? 17 : distM < 100 ? 16 : 15)
            : 15; // Default zoom for non-snapped peaks

        map.current.flyTo({
            center: [centerLon, centerLat],
            zoom: zoom,
            pitch: 65,
            bearing: Math.random() * 60 - 30,
            duration: 2000,
            essential: true,
        });
    }, [peak, mapLoaded]);

    return (
        <div className="relative w-full h-full" style={{ minHeight: "400px" }}>
            <div ref={mapContainer} className="w-full h-full" />
            {pickingMode && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-purple-600 text-white px-4 py-2 rounded-full text-sm font-medium shadow-lg flex items-center gap-2 animate-pulse-subtle">
                    <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="16" />
                        <line x1="8" y1="12" x2="16" y2="12" />
                    </svg>
                    Click map to place custom marker
                </div>
            )}
        </div>
    );
}
