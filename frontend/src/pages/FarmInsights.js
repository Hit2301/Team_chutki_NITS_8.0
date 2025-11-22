

// src/pages/FarmInsights.js
import React, { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { auth, db } from "../firebase";
import { doc, getDoc } from "firebase/firestore";
import { MapContainer, TileLayer, Polygon, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import API_BASE from "../apiBase";
import { get, set as idbSet, del as idbDel, keys as idbKeys } from "idb-keyval";
import "./FarmInsights.css";

/* -------------------------
   Helpers (kept small & robust)
   ------------------------- */
// Accept the shapes we used elsewhere: [{lat,lng}, [lng,lat], [lat,lng], GeoPoint...]
function normalizeToLatLngArray(coords) {
  if (!coords) return [];
  // if array of objects {lat,lng}
  if (Array.isArray(coords) && coords.length && typeof coords[0] === "object" && ("lat" in coords[0] || "latitude" in coords[0])) {
    return coords.map((pt) => {
      const lat = pt.lat ?? pt.latitude ?? null;
      const lng = pt.lng ?? pt.longitude ?? null;
      return [Number(lat), Number(lng)];
    }).filter(p => !isNaN(p[0]) && !isNaN(p[1]));
  }
  // if array of arrays [lng,lat] or [lat,lng]
  if (Array.isArray(coords) && coords.length && Array.isArray(coords[0])) {
    const first = coords[0].map(Number);
    // if first[0] plausibly latitude (-90..90) and first[1] plausible longitude (-180..180) => assume [lat,lng]
    if (Math.abs(first[0]) <= 90 && Math.abs(first[1]) <= 180) {
      return coords.map((p) => [Number(p[0]), Number(p[1])]);
    } else {
      // else assume [lng,lat] -> swap to [lat,lng]
      return coords.map((p) => [Number(p[1]), Number(p[0])]);
    }
  }
  // if single GeoPoint object
  if (coords && typeof coords === "object" && "latitude" in coords && "longitude" in coords) {
    return [[Number(coords.latitude), Number(coords.longitude)]];
  }
  return [];
}

function centroidOfLatLngs(latlngs) {
  if (!latlngs || !latlngs.length) return null;
  let sumLat = 0, sumLng = 0;
  latlngs.forEach(([lat, lng]) => { sumLat += lat; sumLng += lng; });
  return [sumLat / latlngs.length, sumLng / latlngs.length];
}

// simple color scale: low moisture -> red, mid -> orange/yellow, high -> green/blue
function moistureToColor(m) {
  if (m == null || isNaN(m)) return "#888";
  if (m < 0.12) return "#e11d48"; // red (very low)
  if (m < 0.20) return "#f97316"; // orange
  if (m < 0.35) return "#f59e0b"; // yellow-orange
  if (m < 0.6) return "#10b981";  // green
  return "#06b6d4";               // blue-ish (wet)
}

// radius for marker: lower moisture -> bigger red circle (to draw attention)
function moistureToRadius(m) {
  if (m == null || isNaN(m)) return 6;
  const base = 6;
  const scale = Math.max(0, (0.3 - m)); // low moisture -> larger
  return Math.round(base + scale * 60);
}

/* -------------------------
   Normalize & safety helpers for analytics response
   (smaller subset of the Dashboard normalizer)
   ------------------------- */
function normalizeAnalytics(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = { ...raw };

  // Ensure arrays exist & normalize common keys used in this file
  if (!Array.isArray(out.soil_moisture)) out.soil_moisture = out.soil_moisture || [];
  if (!Array.isArray(out.ndvi_timeseries)) out.ndvi_timeseries = out.ndvi_timeseries || [];
  if (!Array.isArray(out.rainfall)) out.rainfall = out.rainfall || [];
  if (!Array.isArray(out.temperature)) out.temperature = out.temperature || [];
  if (!Array.isArray(out.lai_timeseries)) out.lai_timeseries = out.lai_timeseries || [];
  if (!Array.isArray(out.canopy_temperature)) out.canopy_temperature = out.canopy_temperature || [];
  if (!Array.isArray(out.soil_temperature)) out.soil_temperature = out.soil_temperature || [];
  if (!out.soil_profile) out.soil_profile = out.soil_profile || out.soil?.profile || {};

  // quick computed aggregates (helpful in UI)
  const safeAvg = (arr, key) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const vals = arr.map(d => {
      if (d == null) return null;
      if (key) return Number(d[key]);
      if (typeof d === "number") return d;
      if ("value" in d) return Number(d.value);
      if ("moisture" in d) return Number(d.moisture);
      for (const k of Object.keys(d)) {
        if (k === "date") continue;
        const n = Number(d[k]);
        if (!isNaN(n)) return n;
      }
      return null;
    }).filter(v => v != null && !isNaN(v));
    if (!vals.length) return null;
    return vals.reduce((a,b)=>a+b,0)/vals.length;
  };

  try {
    out.avg_ndvi = safeAvg(out.ndvi_timeseries, "ndvi");
    out.avg_soil_moisture = safeAvg(out.soil_moisture, "moisture");
    out.total_rain_mm = Array.isArray(out.rainfall) ? out.rainfall.reduce((s,d) => s + (Number(d?.rain_mm || d?.rain || 0)), 0) : null;
    out.avg_canopy_temp = safeAvg(out.canopy_temperature, "canopy_temp");
    out.avg_lai = safeAvg(out.lai_timeseries, "lai");
  } catch (e) {
    // noop
  }

  return out;
}

/* -------------------------
   Main Component
   ------------------------- */
export default function FarmInsights() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [farm, setFarm] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // load farm doc from Firestore (tries user subcollection then root)
  useEffect(() => {
    let cancelled = false;
    const fetchFarm = async () => {
      setLoading(true);
      setError("");
      try {
        const user = auth.currentUser;
        if (user) {
          const userFarmRef = doc(db, "users", user.uid, "farms", id);
          const snap = await getDoc(userFarmRef);
          if (snap.exists()) {
            if (cancelled) return;
            setFarm({ id: snap.id, ...snap.data() });
            return;
          }
        }
        const rootRef = doc(db, "farms", id);
        const rootSnap = await getDoc(rootRef);
        if (rootSnap.exists()) {
          if (cancelled) return;
          setFarm({ id: rootSnap.id, ...rootSnap.data() });
          return;
        }
        setError("Farm not found (or you are not authorized to read it).");
      } catch (err) {
        console.error("Error fetching farm:", err);
        setError("Error fetching farm (check console).");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchFarm();
    return () => { cancelled = true; };
  }, [id]);

  // once farm is available, load analytics: try IndexedDB cache -> fallback to backend
  useEffect(() => {
    if (!farm) return;
    let cancelled = false;

    const loadForFarm = async () => {
      setLoading(true);
      try {
        // 1) try reading global analyticsCache saved by FarmDashboard
        const savedCache = await get("analyticsCache");
        if (savedCache && typeof savedCache === "object") {
          // find keys that belong to this farm (keys formatted like `${farmId}_${start}_${end}`)
          const candidateKeys = Object.keys(savedCache || {}).filter(k => k.startsWith(`${id}_`));
          if (candidateKeys.length) {
            // choose best by timestamp inside saved entry if available, else pick last created key
            let bestKey = candidateKeys[0];
            let bestStamp = -Infinity;
            candidateKeys.forEach(k => {
              const val = savedCache[k];
              if (!val) return;
              const stamp = (val.response && val.response.timestamp) ? Date.parse(val.response.timestamp) :
                            (val._cached_at_ts ? Number(val._cached_at_ts) * 1000 : -Infinity);
              if (stamp && stamp > bestStamp) {
                bestStamp = stamp;
                bestKey = k;
              }
            });
            const cachedEntry = savedCache[bestKey];
            if (cachedEntry) {
              console.log("✅ FarmInsights: loaded analytics from IndexedDB key:", bestKey);
              const normalized = normalizeAnalytics(cachedEntry.response || cachedEntry);
              if (!cancelled) setAnalytics(normalized);
              setLoading(false);
              return;
            }
          } else {
            console.log("ℹ️ FarmInsights: no matching cache key for this farm in analyticsCache");
          }
        } else {
          console.log("ℹ️ FarmInsights: analyticsCache not found in IndexedDB");
        }

        // 2) fallback: call backend analytics POST (send farm coordinates, include farm_id to let server cache)
        if (farm.coordinates && farm.coordinates.length) {
          try {
            const cleanCoords = farm.coordinates;
            const body = {
              coordinates: cleanCoords,
              start_date: undefined, // server will use its default (last 3 months) if not provided
              end_date: undefined,
              farm_id: id,
              force_refresh: false
            };
            const res = await fetch(`${API_BASE}/analytics`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const data = await res.json();
            if (data.error) {
              console.error("❌ Backend error fetching analytics:", data.error);
              if (!cancelled) setError("Failed to fetch analytics: " + data.error);
            } else {
              console.log("✅ FarmInsights: fetched analytics from backend", data);
              const normalized = normalizeAnalytics(data);
              if (!cancelled) setAnalytics(normalized);

              // also try to save into analyticsCache (so dashboard and insights share it)
              try {
                const globalCache = (await get("analyticsCache")) || {};
                // create a simple cacheKey: farmId_start_end if server responded with dates, else farmId_now
                const start = data.start_date || "";
                const end = data.end_date || "";
                const cacheKey = `${id}_${start || "auto"}_${end || "auto"}`;
                globalCache[cacheKey] = { _cached_at_ts: Math.floor(Date.now() / 1000), response: data };
                await idbSet("analyticsCache", globalCache);
                console.log("💾 FarmInsights: saved analytics to IndexedDB under", cacheKey);
              } catch (e) {
                console.warn("⚠️ Could not save analytics to IndexedDB:", e);
              }
            }
          } catch (err) {
            console.error("❌ Error fetching analytics from backend:", err);
            if (!cancelled) setError("Failed to fetch analytics (check console).");
          }
        } else {
          console.warn("⚠️ No farm coordinates present to request analytics.");
        }
      } catch (err) {
        console.error("❌ Unexpected error in FarmInsights analytics loader:", err);
        if (!cancelled) setError("Failed to load analytics.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadForFarm();
    return () => { cancelled = true; };
  }, [farm, id]);

  // determine soil points to draw on the map (robust to different analytics shapes)
  const polygonPositions = useMemo(() => normalizeToLatLngArray(farm?.coordinates), [farm]);
  const soilPoints = useMemo(() => {
    if (!analytics && !farm) return [];

    // 1) If backend returns detailed points
    if (analytics?.soil_moisture_points && Array.isArray(analytics.soil_moisture_points)) {
      return analytics.soil_moisture_points
        .map((p) => {
          const lat = p.lat ?? p.latitude ?? p[1];
          const lng = p.lng ?? p.longitude ?? p[0];
          return { lat: Number(lat), lng: Number(lng), moisture: Number(p.moisture ?? p.value ?? p.m ?? null), date: p.date ?? p.timestamp ?? null };
        })
        .filter(pt => !isNaN(pt.lat) && !isNaN(pt.lng));
    }

    // 2) if analytics.soil_samples with coords
    if (analytics?.soil_samples && Array.isArray(analytics.soil_samples)) {
      return analytics.soil_samples
        .map((s) => {
          const lat = s.lat ?? s.latitude ?? s.location?.lat ?? null;
          const lng = s.lng ?? s.longitude ?? s.location?.lng ?? null;
          return { lat: Number(lat), lng: Number(lng), moisture: Number(s.moisture ?? s.value ?? s.moisture_value ?? null), date: s.date ?? s.sample_date ?? null };
        })
        .filter(pt => !isNaN(pt.lat) && !isNaN(pt.lng));
    }

    // fallback: create single centroid point with aggregated moisture (if no coords available)
    const centroid = centroidOfLatLngs(polygonPositions);
    if (!centroid) return [];
    let avg = null;
    const arr = analytics?.soil_moisture ?? analytics?.soil_moisture_timeseries ?? [];
    if (Array.isArray(arr) && arr.length) {
      const vals = arr.map(d => {
        if (typeof d === "number") return d;
        if (d == null) return null;
        if ("moisture" in d) return Number(d.moisture);
        if ("value" in d) return Number(d.value);
        for (const k of Object.keys(d)) {
          if (k === "date") continue;
          const n = Number(d[k]);
          if (!isNaN(n)) return n;
        }
        return null;
      }).filter(v => v != null && !isNaN(v));
      if (vals.length) avg = vals.reduce((a,b)=>a+b,0)/vals.length;
    }
    if (avg == null && typeof analytics?.soil_moisture === "number") avg = analytics.soil_moisture;
    return [{ lat: centroid[0], lng: centroid[1], moisture: avg, date: null }];
  }, [analytics, farm, polygonPositions]);

  if (loading) return <div className="insights-container">⏳ Loading... Plizz Wailt....</div>;
  if (error) return <div className="insights-container">❌ {error}</div>;

  const center = polygonPositions.length ? centroidOfLatLngs(polygonPositions) : [farm?.location?.lat ?? 23.0225, farm?.location?.lng ?? 72.5714];

  return (
    <div className="insights-container">
      <h2>🌱 Farm Insights</h2>

      {farm && (
        <div className="farm-info">
          <h3>📍 {farm.name}</h3>
          <p>Date: {farm.date ?? "N/A"}</p>
          <p>Soil Type: {farm.details?.soilType ?? "N/A"}</p>
        </div>
      )}

      {/* Map showing farm polygon */}
      {polygonPositions && polygonPositions.length > 0 ? (
        <div className="farm-map">
          <MapContainer center={center} zoom={17} style={{ height: "500px", width: "100%" }}>
            {/* Permanent Satellite Layer (Esri World Imagery) */}
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              attribution='Tiles &copy; <a href="https://www.esri.com/">Esri</a>, Earthstar Geographics'
            />

            {/* Farm Polygon Overlay */}
            <Polygon
              positions={polygonPositions}
              pathOptions={{
                color: "lightgreen",
                weight: 2,
                fillColor: "lightgreen",
                fillOpacity: 0.2
              }}
            />

            {/* Soil moisture markers */}
            {soilPoints.map((p, i) => {
              const color = moistureToColor(p.moisture);
              const radius = moistureToRadius(p.moisture);
              return (
                <React.Fragment key={i}>
                  {p.moisture != null && p.moisture < 0.12 && (
                    <CircleMarker center={[p.lat, p.lng]} radius={radius + 8} pathOptions={{ color: color, opacity: 0.18, fillOpacity: 0.06 }} />
                  )}
                  <CircleMarker center={[p.lat, p.lng]} radius={Math.max(6, radius)} pathOptions={{ color: color, fillColor: color, fillOpacity: 0.85, weight: 1 }}>
                    <Tooltip direction="top" offset={[0, -10]}>
                      <div style={{ minWidth: 120 }}>
                        <div><strong>Moisture:</strong> {p.moisture == null || isNaN(p.moisture) ? "N/A" : (Number(p.moisture).toFixed(2))}</div>
                        {p.date && <div><small>{p.date}</small></div>}
                        <div><small style={{ opacity: 0.85 }}>{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</small></div>
                      </div>
                    </Tooltip>
                  </CircleMarker>
                </React.Fragment>
              );
            })}
          </MapContainer>
        </div>
      ) : (
        <p>⚠️ No coordinates found for this farm.</p>
      )}

      {/* Small analytics summary */}
      {analytics && (
        <div className="insights-section">
          <h3>📊 Quick analytics</h3>
          <div className="indicators">
            <div className="indicator">
              <div className="label">Avg NDVI</div>
              <div className="value">{analytics.avg_ndvi ?? analytics.ndvi ?? "N/A"}</div>
            </div>
            <div className="indicator">
              <div className="label">Avg Soil Moisture</div>
              <div className="value">{analytics.avg_soil_moisture ?? "N/A"}</div>
            </div>
            <div className="indicator">
              <div className="label">Total Rain (mm)</div>
              <div className="value">{analytics.total_rain_mm ?? analytics.total_rain_mm ?? "N/A"}</div>
            </div>
          </div>
        </div>
      )}

      {/* AI Prediction Section */}
      {analytics?.ml_prediction && (
        <div className={`insights-section ai-section ${
          analytics.ml_prediction === "healthy" ? "ai-healthy" :
          analytics.ml_prediction === "moderate" ? "ai-moderate" : "ai-stressed"
        }`}>
          <h3>🤖 AI Crop Health Prediction</h3>
          <div className="indicators">
            <div className="indicator">
              <div className="label">Predicted Status</div>
              <div className="value capitalize">{analytics.ml_prediction}</div>
            </div>
            {analytics.ml_confidence != null && (
              <div className="indicator">
                <div className="label">Confidence</div>
                <div className="value">{(analytics.ml_confidence * 100).toFixed(1)}%</div>
              </div>
            )}
          </div>
          <div className="ai-summary">
            {analytics.ml_prediction === "healthy" && <p>🌿 Crops look healthy — maintain irrigation and nutrient schedule.</p>}
            {analytics.ml_prediction === "moderate" && <p>⚠️ Moderate stress detected — monitor soil moisture and consider light interventions.</p>}
            {analytics.ml_prediction === "stressed" && <p>🚨 High stress detected — inspect irrigation, pests, and fertilizer deficiency areas immediately.</p>}
          </div>
        </div>
      )}

      <div className="insights-section recommendations">
        <h3>Recommendations</h3>
        <ul>
          <li>🔴 Red circles = low moisture. Consider targeted irrigation there.</li>
          <li>🟡 Orange = moderate; monitor.</li>
          <li>🟢 Green/blue = healthy/wet.</li>
        </ul>
      </div>

      <button className="back-btn" onClick={() => navigate(`/farm/${id}`)}>⬅ Back to Dashboard</button>
    </div>
  );
}
