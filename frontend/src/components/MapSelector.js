// src/components/MapSelector.js
import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";
import API_BASE from "../apiBase"; // ✅ backend URL

export default function MapSelector({ onSave }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);

  useEffect(() => {
    if (!leafletMap.current) {
      const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
      const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}");
      const labels = L.tileLayer("https://stamen-tiles.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png");

      const map = L.map(mapRef.current, {
        center: [23.0225, 72.5714],
        zoom: 13,
        layers: [sat, labels],
      });

      const baseMaps = { Satellite: sat, OSM: osm };
      L.control.layers(baseMaps).addTo(map);

      const drawnItems = new L.FeatureGroup();
      map.addLayer(drawnItems);

      const drawControl = new L.Control.Draw({
        draw: { polygon: true, polyline: false, circle: false, marker: false, circlemarker: false, rectangle: true },
        edit: { featureGroup: drawnItems },
      });
      map.addControl(drawControl);

      map.on(L.Draw.Event.CREATED, async (e) => {
        const layer = e.layer;
        drawnItems.addLayer(layer);

        // Convert polygon points to [lng, lat]
        //const coords = layer.getLatLngs()[0].map((pt) => [pt.lng, pt.lat]);
        // inside draw-created handler
        const
         raw = layer.getLatLngs()[0];
        const coords = raw.map(pt => [pt.lng, pt.lat]); // ensure flat [lon,lat]
        onSave(coords);
        console.log("📍 Selected polygon coords:", coords);

        // Send polygon to backend immediately (optional preview)
        try {
          const res = await fetch(`${API_BASE}/analytics`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              coordinates: coords,
              start_date: "2025-08-27", // default range
              end_date: "2025-09-27",
            }),
          });

          if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Server error ${res.status}: ${errorText}`);
          }

          const data = await res.json();
          console.log("📊 Backend analytics preview:", data);

          if (onSave) {
            onSave(coords, data);
          }
        } catch (err) {
          console.error("❌ Error sending polygon:", err);
        }
      });

      leafletMap.current = map;
    }
  }, [onSave]);

  return <div ref={mapRef} style={{ height: "400px", width: "100%" }} />;
}
