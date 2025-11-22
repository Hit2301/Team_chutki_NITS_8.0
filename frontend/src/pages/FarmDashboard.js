/* eslint-disable react-hooks/exhaustive-deps */
/* src/pages/FarmDashboard.js */

import "./FarmDashboard.css";
import React, { useEffect, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import { auth, db } from "../firebase";
import { doc, getDoc } from "firebase/firestore";
import API_BASE from "../apiBase";
import { set, get, del, keys } from 'idb-keyval';


/* -------------------------
   Circle Indicator component
   ------------------------- */
function CircleIndicator({ label, value, max = 1, thresholds = [], precision = 2 }) {
  if (value == null || isNaN(Number(value))) {
    return (
      <div className="circle-indicator">
        <div className="circle-empty">N/A</div>
        <div className="circle-label">{label}</div>
      </div>
    );
  }
  const percent = Math.min(Math.max((Number(value) / Number(max)) * 100, 0), 100);
  let status = "Unknown";
  let colorClass = "indicator-default";
  for (let t of thresholds) {
    if (value <= t.limit) {
      status = t.label;
      colorClass = t.colorClass || "indicator-default";
      break;
    }
  }
  if (thresholds.length && value > thresholds[thresholds.length - 1].limit) {
    const last = thresholds[thresholds.length - 1];
    status = last.label;
    colorClass = last.colorClass || colorClass;
  }
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const dash = (percent / 100) * circumference;

  return (
    <div className="circle-indicator">
      <svg width="92" height="92" viewBox="0 0 100 100" className="circle-svg">
        <circle cx="50" cy="50" r={radius} stroke="#e5e7eb" strokeWidth="10" fill="none" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          stroke={
            colorClass === "indicator-good"
              ? "#16a34a"
              : colorClass === "indicator-warning"
                ? "#d97706"
                : colorClass === "indicator-bad"
                  ? "#dc2626"
                  : "#3b82f6"
          }
          strokeWidth="10"
          fill="none"
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
        />
        <text x="50" y="54" textAnchor="middle" fontSize="12" fill="#111827" fontWeight="600">
          {Number(percent).toFixed(0)}%
        </text>
      </svg>
      <div className="circle-label">{label}</div>
      <div className={`circle-status ${colorClass}`}>{status}</div>
      <div className="circle-value">{Number(value).toFixed(precision)}</div>
    </div>
  );
}

/* -------------------------
   Helpers
   ------------------------- */
const safeAvg = (series, key) => {
  if (!series || !series.length) return null;
  const vals = series
    .map((d) => {
      if (d == null) return null;
      if (key) return Number(d[key]);
      if (typeof d === "number") return d;
      if ("value" in d) return Number(d.value);
      return NaN;
    })
    .filter((v) => v != null && !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

/* parse farm coordinates from common stored shapes
   - accepts GeoPoint objects ({ latitude, longitude })
   - accepts {lat, lng}
   - accepts nested arrays [lat, lng] or [lng, lat]
   - returns array of [lng, lat] pairs suitable for server */
function parseCoords(coords) {
  if (!coords) return [];

  // If string, try parse JSON
  if (typeof coords === "string") {
    try {
      const parsed = JSON.parse(coords);
      return parseCoords(parsed);
    } catch {
      // fallback: try "lat,lng;lat,lng"
      if (coords.includes(",")) {
        const parts = coords.split(";").map((p) => p.trim());
        const arr = parts.map((pr) => {
          const [a, b] = pr.split(",").map(Number);
          // assume lat,lng
          return [b, a];
        });
        return arr;
      }
      return [];
    }
  }

  // If single GeoPoint object
  if (coords && typeof coords === "object" && "latitude" in coords && "longitude" in coords) {
    return [[coords.longitude, coords.latitude]];
  }

  // If array:
  if (Array.isArray(coords)) {
    // nested arrays like [[lat,lng], [lat,lng]] or [[lng,lat], ...]
    if (coords.length && Array.isArray(coords[0])) {
      // detect order using heuristic on first coordinate
      const first = coords[0];
      const a = Number(first[0]);
      const b = Number(first[1]);
      if (!isNaN(a) && !isNaN(b)) {
        // if a in [-90,90] likely lat -> so swap to [lng,lat]
        if (a >= -90 && a <= 90 && b >= -180 && b <= 180) {
          return coords.map((p) => [Number(p[1]), Number(p[0])]);
        }
        // else assume already [lng,lat]
        return coords.map((p) => [Number(p[0]), Number(p[1])]);
      }
    }

    // array of objects: either {lat,lng} or {latitude,longitude}
    if (coords.length && typeof coords[0] === "object") {
      if ("lat" in coords[0] && "lng" in coords[0]) {
        return coords.map((pt) => [Number(pt.lng), Number(pt.lat)]);
      }
      if ("latitude" in coords[0] && "longitude" in coords[0]) {
        return coords.map((pt) => [Number(pt.longitude), Number(pt.latitude)]);
      }
      // fallback: if object contains keys like 'lng' but nested
      return coords
        .map((pt) => {
          const keys = Object.keys(pt);
          // pick two numeric keys
          const nums = keys.map((k) => Number(pt[k])).filter((v) => !isNaN(v));
          if (nums.length >= 2) {
            // guess first lat, second lng -> produce [lng,lat]
            return [nums[1], nums[0]];
          }
          return [];
        })
        .filter((p) => p.length === 2);
    }

    // fallback: unknown array shape
    return coords;
  }

  // fallback default
  return [];
}

/* -------------------------
   Normalize server response and convert Temps from K -> °C if needed
   Ensures arrays exist for expected keys and renames fields for charts.
   ------------------------- */
function normalizeAnalytics(raw) {
  if (!raw || typeof raw !== "object") return null;
  // shallow copy
  const out = { ...raw };

  // If server nested many values inside out.weather or out.soil, fallback accordingly
  if ((!out.temperature || !out.temperature.length) && out.weather && Array.isArray(out.weather.temperature)) {
    out.temperature = out.weather.temperature;
  }
  if ((!out.rainfall || !out.rainfall.length) && out.weather && Array.isArray(out.weather.rainfall)) {
    out.rainfall = out.weather.rainfall;
  }
  if ((!out.soil_moisture || !out.soil_moisture.length) && out.soil && Array.isArray(out.soil.moisture)) {
    out.soil_moisture = out.soil.moisture;
  }
  if ((!out.soil_temperature || !out.soil_temperature.length) && out.soil && Array.isArray(out.soil.temperature)) {
    out.soil_temperature = out.soil.temperature;
  }

  // Normalize temperature arrays to use key 'temp' and convert Kelvin -> Celsius heuristically
  if (Array.isArray(out.temperature)) {
    out.temperature = out.temperature.map((d) => {
      if (!d) return d;
      const newObj = { ...d };
      // find the numeric temperature field
      let val = null;
      if ("temp" in d) val = Number(d.temp);
      else if ("temperature" in d) val = Number(d.temperature);
      else {
        // pick first numeric field that's not date
        for (const k of Object.keys(d)) {
          if (k === "date") continue;
          const n = Number(d[k]);
          if (!isNaN(n)) {
            val = n;
            break;
          }
        }
      }
      if (val == null || isNaN(val)) {
        return d;
      }
      // if the value is large (>100), treat as Kelvin -> convert
      if (val > 100) val = val - 273.15;
      return { date: d.date, temp: Number(val) };
    });
  } else {
    out.temperature = [];
  }

  // soil_temperature -> key soil_temp and convert Kelvin->C if needed
  if (Array.isArray(out.soil_temperature)) {
    out.soil_temperature = out.soil_temperature.map((d) => {
      if (!d) return d;
      // if object already has soil_temp
      if ("soil_temp" in d) {
        const v = Number(d.soil_temp);
        return { date: d.date, soil_temp: isNaN(v) ? null : (v > 100 ? v - 273.15 : v) };
      }
      // try other keys
      let val = null;
      if ("st" in d) val = Number(d.st);
      else {
        for (const k of Object.keys(d)) {
          if (k === "date") continue;
          const n = Number(d[k]);
          if (!isNaN(n)) {
            val = n;
            break;
          }
        }
      }
      if (val == null || isNaN(val)) return { date: d.date, soil_temp: null };
      if (val > 100) val = val - 273.15;
      return { date: d.date, soil_temp: Number(val) };
    });
  } else out.soil_temperature = [];

  // canopy_temperature -> normalize to canopy_temp and convert
  if (Array.isArray(out.canopy_temperature)) {
    out.canopy_temperature = out.canopy_temperature.map((d) => {
      if (!d) return d;
      let val = null;
      if ("canopy_temp" in d) val = Number(d.canopy_temp);
      else {
        for (const k of Object.keys(d)) {
          if (k === "date") continue;
          const n = Number(d[k]);
          if (!isNaN(n)) {
            val = n;
            break;
          }
        }
      }
      if (val == null || isNaN(val)) return { date: d.date, canopy_temp: null };
      if (val > 100) val = val - 273.15;
      return { date: d.date, canopy_temp: Number(val) };
    });
  } else out.canopy_temperature = [];

  // Rainfall: ensure the key for bar chart is 'rain_mm'
  if (Array.isArray(out.rainfall)) {
    out.rainfall = out.rainfall.map((d) => {
      if (!d) return d;
      if ("rain_mm" in d) return d;
      if ("rain" in d) return { date: d.date, rain_mm: Number(d.rain) };
      // fallback pick first numeric
      for (const k of Object.keys(d)) {
        if (k === "date") continue;
        const n = Number(d[k]);
        if (!isNaN(n)) return { date: d.date, rain_mm: n };
      }
      return { date: d.date, rain_mm: null };
    });
  } else out.rainfall = [];

  // Ensure vegetation indices arrays exist
  const expectedArrays = [
    "ndvi_timeseries",
    "evi_timeseries",
    "gndvi_timeseries",
    "savi_timeseries",
    "ndwi_timeseries",
    "msavi_timeseries",
    "arvi_timeseries",
    "lai_timeseries",
    "chlorophyll_index",
    "water_stress_index",
    "biomass_proxy",
    "canopy_fraction",
    "soil_moisture",
  ];
  for (const k of expectedArrays) {
    if (!Array.isArray(out[k])) out[k] = [];
  }

  // Ensure soil_profile exists
  if (!out.soil_profile) out.soil_profile = out.soil ? out.soil.profile || {} : {};

  // Alerts fallback
  if (!out.alerts) out.alerts = { frost: [], heat: [] };

  return out;
}

/* -------------------------
   Small chart wrappers (re-usable)
   ------------------------- */
const SeriesLineChart = ({ title, data, dataKey, height = 240 }) => (
  <div className="chart-card">
    <h4 className="section-title">{title}</h4>
    {!data || !data.length ? (
      <div className="no-data">No data available</div>
    ) : (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey={dataKey} stroke="#2563eb" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    )}
  </div>
);

const RainBarChart = ({ title, data }) => (
  <div className="chart-card">
    <h4 className="section-title">{title}</h4>
    {!data || !data.length ? (
      <div className="no-data">No rainfall data</div>
    ) : (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Bar dataKey="rain_mm" fill="#0ea5e9" />
        </BarChart>
      </ResponsiveContainer>
    )}
  </div>
);

/* -------------------------
   Main component
   ------------------------- */
export default function FarmDashboard() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [farm, setFarm] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [updatingLabel, setUpdatingLabel] = useState("");

  const isMounted = useRef(true);
  const analyticsCacheRef = useRef({});


  const [startDate, setStartDate] = useState(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 90);
    return start.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));


  // useEffect(() => {
  //   const savedCache = localStorage.getItem("analyticsCache");
  //   if (savedCache) {
  //     try {
  //       analyticsCacheRef.current = JSON.parse(savedCache);
  //       console.log("✅ Restored analytics cache from localStorage");
  //     } catch (e) {
  //       console.warn("Failed to parse saved analytics cache:", e);
  //     }
  //   }
  // }, []);



  useEffect(() => {
  const loadCache = async () => {
    try {
      const savedCache = await get("analyticsCache");
      if (savedCache) {
        analyticsCacheRef.current = savedCache;
        console.log("✅ Restored analytics cache from IndexedDB");
      } else {
        console.log("ℹ️ No saved cache found in IndexedDB");
      }
    } catch (err) {
      console.warn("⚠️ Failed to load analytics cache from IndexedDB:", err);
    }
  };
  loadCache();
}, []);


  // // Save cache to localStorage whenever analytics updatef
  // useEffect(() => {
  //   localStorage.setItem("analyticsCache", JSON.stringify(analyticsCacheRef.current));
  // }, [analytics]);


  useEffect(() => {
  const saveCache = async () => {
    try {
      await set("analyticsCache", analyticsCacheRef.current);
      console.log("💾 Saved analytics cache to IndexedDB");
    } catch (err) {
      console.warn("⚠️ Failed to save analytics cache to IndexedDB:", err);
    }
  };
  if (analyticsCacheRef.current) saveCache();
}, [analytics]);



  useEffect(() => {
    isMounted.current = true;
    // fetch farm from Firestore - tries user subcollection then root collection
    const fetchFarm = async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          console.warn("No logged-in user (auth.currentUser missing). Cannot fetch user-specific farm. Trying fallback collections.");
        }

        let farmSnap = null;
        if (user) {
          try {
            const farmRef = doc(db, "users", user.uid, "farms", id);
            farmSnap = await getDoc(farmRef);
            if (farmSnap && farmSnap.exists()) {
              const farmData = { id: farmSnap.id, ...farmSnap.data() };
              if (isMounted.current) {
                setFarm(farmData);
                fetchAnalytics(farmData.coordinates, startDate, endDate, false);
              }
              return;
            }
          } catch (err) {
            console.warn("Attempt to fetch user farm failed:", err);
          }
        }

        // fallback: root collection 'farms' doc
        try {
          const rootRef = doc(db, "farms", id);
          const rootSnap = await getDoc(rootRef);
          if (rootSnap && rootSnap.exists()) {
            const farmData = { id: rootSnap.id, ...rootSnap.data() };
            if (isMounted.current) {
              setFarm(farmData);
              fetchAnalytics(farmData.coordinates, startDate, endDate, false);
            }
            return;
          }
        } catch (err) {
          console.warn("Attempt to fetch root farms doc failed:", err);
        }

        console.error("Farm not found in Firestore for id:", id);
      } catch (err) {
        console.error("Error fetching farm:", err);
      }
    };

    fetchFarm();

    return () => {
      isMounted.current = false;
    };
  }, [id]);

  const fetchAnalytics = async (coords, start, end, showLabel = true, forceRefresh = false) => {
    const cleanCoords = parseCoords(coords);
    console.log("📤 Sending analytics payload:", { coordinates: cleanCoords, start_date: start, end_date: end, force_refresh: forceRefresh });


    const cacheKey = `${id}_${start}_${end}`;
    if (!forceRefresh && analyticsCacheRef.current[cacheKey]) {
      console.log("✅ Using cached analytics from frontend:", cacheKey);
      setAnalytics(analyticsCacheRef.current[cacheKey]);
      return;
    }


    try {
      setLoading(true);
      if (showLabel) setUpdatingLabel(`Analyzing between ${start} and ${end}...`);
      setAnalytics(null);

      const res = await fetch(`${API_BASE}/analytics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coordinates: cleanCoords,
          start_date: start,
          end_date: end,
          farm_id: id,
          force_refresh: forceRefresh,
        }),
      });

      const data = await res.json();
      console.log("<< analytics response >>", data);

      if (data.error) {
        console.error("❌ Backend error:", data.error);
        alert("Server error: " + data.error);
        return;
      }

      const normalized = normalizeAnalytics(data);
      if (isMounted.current) {
        setAnalytics(normalized);

        // 🔹 Save result into frontend cache
        analyticsCacheRef.current[cacheKey] = normalized;

        // 🔹 Force React to re-render by cloning the object
        setAnalytics({ ...normalized });
      }


      if (showLabel && isMounted.current) {
        setUpdatingLabel(`Analysis complete between ${start} and ${end}`);
        setTimeout(() => {
          if (isMounted.current) setUpdatingLabel("");
        }, 2400);
      }
    } catch (err) {
      console.error("❌ Fetch analytics failed:", err);
      alert("Failed to fetch analytics (check console).");
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const handleDateSubmit = () => {
    if (!farm || !farm.coordinates || (Array.isArray(farm.coordinates) && farm.coordinates.length === 0)) {
      console.error("⚠️ No coordinates found for this farm");
      alert("No coordinates available for this farm. Please check farm settings.");
      return;
    }
    setUpdatingLabel(`Analyzing between ${startDate} and ${endDate}...`);
    fetchAnalytics(farm.coordinates, startDate, endDate, true);
  };

  if (!farm) {
    return <div className="dashboard-container">⚠️ Farm not found. Save farm first or login.</div>;
  }

  // compute averages (defensive)
  const avgNDVI = safeAvg(analytics?.ndvi_timeseries, "ndvi");
  const avgEVI = safeAvg(analytics?.evi_timeseries, "evi");
  const avgGNDVI = safeAvg(analytics?.gndvi_timeseries, "gndvi");
  const avgSAVI = safeAvg(analytics?.savi_timeseries, "savi");
  const avgMSAVI = safeAvg(analytics?.msavi_timeseries, "msavi");
  const avgARVI = safeAvg(analytics?.arvi_timeseries, "arvi");
  const avgNDWI = safeAvg(analytics?.ndwi_timeseries, "ndwi");
  const avgMoisture = safeAvg(analytics?.soil_moisture, "moisture");
  const avgSoilTemp = safeAvg(analytics?.soil_temperature, "soil_temp"); // already converted to °C by normalizer
  const totalRain = analytics?.rainfall?.length ? analytics.rainfall.reduce((a, b) => a + (b.rain_mm || 0), 0) : 0;
  const avgLAI = safeAvg(analytics?.lai_timeseries, "lai");
  const avgCanopyFrac = safeAvg(analytics?.canopy_fraction, "canopy_frac");
  const avgChlorophyll = safeAvg(analytics?.chlorophyll_index, "chlorophyll");
  const avgWSI = safeAvg(analytics?.water_stress_index, "wsi");
  const ndviTrend = analytics?.ndvi_trend_slope_per_day ?? null;

  // choose soil details: prefer farm.details (saved from NewFarm.js), fallback to analytics.soil_profile
  const soilDetails = farm?.details || analytics?.soil_profile || null;

  return (
    <div className="dashboard-container">
      <div className="header">
        <h2 className="dashboard-title">🌱 {farm.name}</h2>
        <div className="date-controls">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          <button onClick={handleDateSubmit} disabled={loading}>🔄 Update</button>
          <button
            onClick={() => {
              if (farm?.coordinates) {
                fetchAnalytics(farm.coordinates, startDate, endDate, true, true);
              }
            }}
            disabled={loading}
          >
            🔁 Refresh Analytics
          </button>

          {loading && <div className="loading-label">⏳ Loading analysis...</div>}
          {updatingLabel && !loading && <div className="success-label">{updatingLabel}</div>}
        </div>
      </div>

      {/* =========================
            Soil Profile Card
         - shows farm.details first, then analytics.soil_profile fallback
         - visible even while analytics are loading
         ========================= */}
      <div className="card soil-profile-card">
        <h3>🪴 Soil Profile</h3>

        {soilDetails ? (
          <div className="soil-profile-table">
            <table className="profile-table">
              <tbody>
                {/* If farm.details exists, it uses the keys you saved from NewFarm.js (soilType, soilTexture, soilDepth...) */}
                {/* If it's analytics.soil_profile, keys may be n, p, k, ph, organic_matter, texture */}
                <tr>
                  <td className="label">🌱 Soil Type</td>
                  <td className="value"> : {soilDetails.soilType ?? soilDetails.type ?? "-"}</td>
                </tr>
                <tr>
                  <td className="label">🧱 Texture</td>
                  <td className="value"> : {soilDetails.soilTexture ?? soilDetails.texture ?? "-"}</td>
                </tr>
                <tr>
                  <td className="label">📏 Depth</td>
                  <td className="value"> : {soilDetails.soilDepth ?? soilDetails.depth ?? "-"}</td>
                </tr>
                <tr>
                  <td className="label">💧 Moisture</td>
                  <td className="value"> : {soilDetails.soilMoisture ?? soilDetails.moisture ?? "-"}</td>
                </tr>
                <tr>
                  <td className="label">⚖️ pH</td>
                  <td className="value"> : {soilDetails.ph ?? soilDetails.ph ?? "-"}</td>
                </tr>
                <tr>
                  <td className="label">🌿 Organic Matter</td>
                  <td className="value"> : {soilDetails.organic ?? soilDetails.organic_matter ?? "-"}</td>
                </tr>
                <tr>
                  <td className="label">🌾 Previous Crop</td>
                  <td className="value"> : {soilDetails.previousCrop ?? "-"}</td>
                </tr>
                <tr>
                  <td className="label">🔄 Repeated Crop</td>
                  <td className="value"> : {soilDetails.repeatedCrop ?? "-"}</td>
                </tr>
                <tr>
                  <td className="label">🌾 Residue Management</td>
                  <td className="value"> : {soilDetails.residue ?? "-"}</td>
                </tr>
                <tr>
                  <td className="label">🧪 Fertilizer Use</td>
                  <td className="value"> : {soilDetails.fertilizer ?? "-"}</td>
                </tr>

                {/* If analytics soil_profile contains NPK numeric values, show them */}
                {soilDetails.n !== undefined || soilDetails.p !== undefined || soilDetails.k !== undefined ? (
                  <>
                    <tr>
                      <td className="label">Nitrogen (N)</td>
                      <td className="value">{soilDetails.n ?? "-"}</td>
                    </tr>
                    <tr>
                      <td className="label">Phosphorus (P)</td>
                      <td className="value">{soilDetails.p ?? "-"}</td>
                    </tr>
                    <tr>
                      <td className="label">Potassium (K)</td>
                      <td className="value">{soilDetails.k ?? "-"}</td>
                    </tr>
                  </>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No soil profile data available for this farm.</p>
        )}
      </div>

      {loading && <div className="loading-screen">⏳ Analyzing between {startDate} and {endDate}...</div>}

      {!loading && analytics && (
        <>
          <div className="summary-row">
            <div className="card growth">
              <h3>🌾 Crop Growth Stage</h3>
              <div className="large">{analytics.growth_stage || "Unknown"}</div>
              <div className="muted">
                Avg NDVI: {avgNDVI != null ? avgNDVI.toFixed(2) : "N/A"} • Trend: {ndviTrend != null ? `${Number(ndviTrend).toExponential(2)} / day` : "N/A"}
              </div>
            </div>

            <div className="card topo">
              <h3>🌍 Topography</h3>
              <div>Elevation: <strong>{analytics.elevation_m != null ? `${Number(analytics.elevation_m).toFixed(1)} m` : "N/A"}</strong></div>
              <div>Slope: <strong>{analytics.slope_deg != null ? `${Number(analytics.slope_deg).toFixed(1)}°` : "N/A"}</strong></div>
              <div>Aspect: <strong>{analytics.aspect_deg != null ? `${Number(analytics.aspect_deg).toFixed(1)}°` : "N/A"}</strong></div>
            </div>

            <div className="card status">
              <h3>📊 Overall Farm Status</h3>
              <div>
                {(() => {
                  const issues = [];
                  if (avgNDVI == null) return "No NDVI data";
                  if (avgNDVI < 0.35) issues.push("Crop health low");
                  if (avgMoisture != null && avgMoisture < 0.12) issues.push("Soil moisture low");
                  if (totalRain === 0) issues.push("No rainfall data");
                  return issues.length ? issues.join(" — ") : "All core metrics look OK.";
                })()}
              </div>
            </div>
          </div>
          <div className="card indicators">
            <h3>🌱 Vegetation & Crop Health</h3>
            <div className="indicators-row">
              <CircleIndicator
                key={`ndvi-${JSON.stringify(analytics)}`}
                label="NDVI"
                value={avgNDVI}
                max={1}
                thresholds={[
                  { limit: 0.3, label: "Poor", colorClass: "indicator-bad" },
                  { limit: 0.6, label: "Moderate", colorClass: "indicator-warning" },
                  { limit: 1, label: "Healthy", colorClass: "indicator-good" },
                ]}
              />
              <CircleIndicator key={`evi-${JSON.stringify(analytics)}`} label="EVI" value={avgEVI} max={1} />
              <CircleIndicator key={`gndvi-${JSON.stringify(analytics)}`} label="GNDVI" value={avgGNDVI} max={1} />
              <CircleIndicator key={`savi-${JSON.stringify(analytics)}`} label="SAVI" value={avgSAVI} max={1} />
              <CircleIndicator key={`ndwi-${JSON.stringify(analytics)}`} label="NDWI" value={avgNDWI} max={1} />
              <CircleIndicator key={`moist-${JSON.stringify(analytics)}`} label="Soil Moisture" value={avgMoisture} max={1} />
              <CircleIndicator key={`soiltemp-${JSON.stringify(analytics)}`} label="Soil Temp (°C)" value={avgSoilTemp} max={50} />
              <CircleIndicator key={`rain-${JSON.stringify(analytics)}`} label="Rainfall (total mm)" value={totalRain} max={500} />
              <CircleIndicator key={`lai-${JSON.stringify(analytics)}`} label="LAI" value={avgLAI} max={10} />
              <CircleIndicator key={`canopy-${JSON.stringify(analytics)}`} label="Canopy Frac" value={avgCanopyFrac} max={1} />
              <CircleIndicator key={`chloro-${JSON.stringify(analytics)}`} label="Chlorophyll" value={avgChlorophyll} max={1} />
              <CircleIndicator key={`wsi-${JSON.stringify(analytics)}`} label="WSI" value={avgWSI} max={1} />
            </div>
          </div>

          <div className="charts">
            <SeriesLineChart key={`ndvi-ts-${JSON.stringify(analytics)}`} title="NDVI Timeseries" data={analytics.ndvi_timeseries} dataKey="ndvi" />
            <SeriesLineChart key={`evi-ts-${JSON.stringify(analytics)}`} title="EVI Timeseries" data={analytics.evi_timeseries} dataKey="evi" />
            <SeriesLineChart key={`gndvi-ts-${JSON.stringify(analytics)}`} title="GNDVI Timeseries" data={analytics.gndvi_timeseries} dataKey="gndvi" />
            <SeriesLineChart key={`savi-ts-${JSON.stringify(analytics)}`} title="SAVI Timeseries" data={analytics.savi_timeseries} dataKey="savi" />
            <SeriesLineChart key={`ndwi-ts-${JSON.stringify(analytics)}`} title="NDWI Timeseries" data={analytics.ndwi_timeseries} dataKey="ndwi" />
            <SeriesLineChart key={`soilmoist-${JSON.stringify(analytics)}`} title="Soil Moisture (time series)" data={analytics.soil_moisture} dataKey="moisture" />
            <SeriesLineChart key={`soiltemp-ts-${JSON.stringify(analytics)}`} title="Soil Temp (time series)" data={analytics.soil_temperature} dataKey="soil_temp" />
            <RainBarChart key={`rain-ts-${JSON.stringify(analytics)}`} title="Daily Rainfall" data={analytics.rainfall} />
            <SeriesLineChart key={`temp-ts-${JSON.stringify(analytics)}`} title="Temperature (time series, °C)" data={analytics.temperature} dataKey="temp" />
            <SeriesLineChart key={`canopytemp-${JSON.stringify(analytics)}`} title="Canopy Temperature (°C)" data={analytics.canopy_temperature} dataKey="canopy_temp" />
            <SeriesLineChart key={`lai-ts-${JSON.stringify(analytics)}`} title="LAI (time series)" data={analytics.lai_timeseries} dataKey="lai" />
          </div>

        </>
      )}

      <button onClick={() => navigate("/home")} className="back-btn">⬅ Back to Home</button>
      {/* Floating Insights Button */}
      <button
        className="floating-insights-btn"
        onClick={() => navigate(`/farm/${id}/insights`)}
      >
        📊 Insights
      </button>
    </div>
  );
}
