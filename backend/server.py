

from flask import Flask, request, jsonify
from flask_cors import CORS
import ee
import datetime
import logging
import os
import math
from statistics import mean
import joblib
import numpy as np

# -------------------- Disk-backed analytics cache (persistent) --------------------
import hashlib
import json

CACHE_PATH = os.environ.get("ANALYTICS_CACHE_PATH", "analytics_cache.json")
# Cache freshness (seconds). Default 7 days.
CACHE_TTL_SECONDS = int(os.environ.get("ANALYTICS_CACHE_TTL", 7 * 24 * 3600))

def _load_cache():
    try:
        if os.path.exists(CACHE_PATH):
            with open(CACHE_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
    except Exception as e:
        logger.warning("Failed to load analytics cache %s: %s", CACHE_PATH, e)
    return {}

def _save_cache(cache_obj):
    try:
        tmp = CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cache_obj, fh, indent=2, default=str)
        os.replace(tmp, CACHE_PATH)
    except Exception as e:
        logger.warning("Failed to save analytics cache %s: %s", CACHE_PATH, e)

def _make_cache_key(coords, start_str, end_str, farm_id=None):
    """
    Deterministic key: hash(farm_id + normalized coords + start + end)
    """
    try:
        coords_sorted = sorted(coords, key=lambda x: (round(float(x[0]), 6), round(float(x[1]), 6)))
        coords_str = "|".join([f"{float(c[0]):.6f},{float(c[1]):.6f}" for c in coords_sorted])
        raw = f"{farm_id or ''}::{coords_str}::{start_str}::{end_str}"
    except Exception:
        raw = f"{farm_id or ''}::{start_str}::{end_str}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
# ---------------------------------------------------------------------------------



# ---------- Logging ----------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("farm-analytics")

# ---------- Flask ----------
app = Flask(__name__)
CORS(app)


# =======================
# Load ML Model
# =======================
ML_MODEL_PATH = "ml/farm_health_model.pkl"  # path to your saved model

try:
    ml_model = joblib.load(ML_MODEL_PATH)
    print(f"✅ ML model loaded successfully from {ML_MODEL_PATH}")
except Exception as e:
    ml_model = None
    print(f"⚠️ ML model not loaded: {e}")


# ---------- Config ----------
# Preferred: set your project id here or via env var
EE_PROJECT = os.environ.get("EE_PROJECT", "earthengine-legacy-473111")

# Optional service-account init (if you want)
EE_SA_EMAIL = os.environ.get("EE_SA_EMAIL")
EE_SA_KEY_PATH = os.environ.get("EE_SA_KEY_PATH")



# ---------- Earth Engine init helpers ----------



def initialize_ee(project=None, service_account_email=None, key_path=None):
    """
    Initialize Earth Engine.
    If service_account_email and key_path provided, tries service-account initialization.
    Otherwise tries normal ee.Initialize(project=...).
    Returns True if EE available, False otherwise.
    """
    try:
        if service_account_email and key_path:
            # service account style (useful for cloud deployments)
            logger.info("Initializing Earth Engine using service account.")
            credentials = ee.ServiceAccountCredentials(service_account_email, key_path)
            ee.Initialize(credentials, project=project)
            logger.info("✅ Earth Engine initialized with service account.")
            return True
        else:
            # standard user credentials
            if project:
                ee.Initialize(project=project)
            else:
                ee.Initialize()
            logger.info("✅ Earth Engine initialized (default).")
            return True
    except Exception as ex:
        logger.error("Earth Engine init failed: %s", ex)
        logger.info("If running locally run: `earthengine authenticate` in your shell.")
        logger.info("If running in cloud use service account credentials and call initialize_ee(service_account_email, key_path, project).")
        return False


# Try to initialize
EE_AVAILABLE = initialize_ee(project=EE_PROJECT, service_account_email=EE_SA_EMAIL, key_path=EE_SA_KEY_PATH)
logger.info("EE_AVAILABLE: %s", EE_AVAILABLE)


# ---------- Utilities ----------
def safe_get_info(eeobj, default=None):
    """Call getInfo() with try/except; returns default on failure."""
    try:
        return eeobj.getInfo()
    except Exception as e:
        logger.warning("getInfo() failed: %s", e)
        return default


def to_iso_date(dt):
    if isinstance(dt, str):
        return dt
    return dt.strftime("%Y-%m-%d")


def polygon_from_coords(coords):
    """
    Accept coords in frontend format (array of [latLng objects] or [ [lng,lat], ... ])
    Return ee.Geometry.Polygon
    """
    if not coords:
        raise ValueError("No coordinates provided")
    # If coords are e.g. [{lat, lng}, ...]
    first = coords[0]
    if isinstance(first, dict) and ("lat" in first or "latitude" in first):
        pts = [[pt.get("lng") or pt.get("longitude"), pt.get("lat") or pt.get("latitude")] for pt in coords]
    else:
        # assume already [lng, lat]
        pts = coords
    # Ensure closed polygon
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    return ee.Geometry.Polygon([pts])


def mean_or_none(values):
    vs = [v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))]
    if not vs:
        return None
    return float(sum(vs) / len(vs))


# ---------- Analytical functions ----------


def timeseries_from_collection(collection, band_expr_or_name, region, start_str, end_str, cloud_pct_threshold=40, reducer=ee.Reducer.mean(), scale=10):
    """
    Generic: from an ImageCollection produce (values_list, dates_list)
    - band_expr_or_name can be a function(img) -> image or a band name string
    - region: ee.Geometry
    """
    try:
        coll = collection.filterBounds(region).filterDate(start_str, end_str)
        # apply cloud filter if attribute exists
        try:
            coll = coll.filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", cloud_pct_threshold))
        except Exception:
            # collection may not have this property; ignore
            pass

        def make_feature(img):
            # compute band value
            if callable(band_expr_or_name):
                band_img = band_expr_or_name(img)
            else:
                band_img = img.select(band_expr_or_name)
            val = band_img.reduceRegion(reducer, region, scale).get(band_img.bandNames().get(0))
            return ee.Feature(None, {"date": img.date().format("YYYY-MM-dd"), "value": val})

        features = coll.map(lambda img: make_feature(img))
        # get arrays
        vals = features.aggregate_array("value")
        dates = features.aggregate_array("date")
        vlist = safe_get_info(vals, default=[])
        dlist = safe_get_info(dates, default=[])
        # convert to list of {date, key}
        out = []
        if vlist and dlist:
            for d, v in zip(dlist, vlist):
                out.append({"date": d, "value": None if v is None else float(v)})
        return out
    except Exception as e:
        logger.warning("timeseries_from_collection failed: %s", e)
        return []


def ndvi_timeseries(region, start_str, end_str):
    # Prefer Sentinel-2 SR Harmonized
    try:
        coll = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(region).filterDate(start_str, end_str)
        try:
            coll = coll.filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 40))
        except Exception:
            pass

        def add_ndvi(img):
            nd = img.normalizedDifference(["B8", "B4"]).rename("NDVI")
            return img.addBands(nd)

        coll = coll.map(add_ndvi)
        # map to features
        def f(img):
            nd = img.select("NDVI")
            v = nd.reduceRegion(ee.Reducer.mean(), region, 10).get("NDVI")
            return ee.Feature(None, {"date": img.date().format("YYYY-MM-dd"), "ndvi": v})

        feats = coll.map(f)
        ndvi_vals = safe_get_info(feats.aggregate_array("ndvi"), default=[])
        ndvi_dates = safe_get_info(feats.aggregate_array("date"), default=[])
        out = []
        if ndvi_vals and ndvi_dates:
            for d, v in zip(ndvi_dates, ndvi_vals):
                out.append({"date": d, "ndvi": None if v is None else float(v)})
        return out
    except Exception as e:
        logger.warning("ndvi_timeseries failed: %s", e)
        return []


def generic_index_timeseries(collection_id, index_expr_fn, region, start_str, end_str, band_name="INDEX"):
    """
    index_expr_fn: function(img) -> ee.Image with single band (index)
    """
    try:
        coll = ee.ImageCollection(collection_id).filterBounds(region).filterDate(start_str, end_str)
        try:
            coll = coll.filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 40))
        except Exception:
            pass
        coll = coll.map(lambda img: img.addBands(index_expr_fn(img).rename(band_name)))
        def f(img):
            val = img.select(band_name).reduceRegion(ee.Reducer.mean(), region, 10).get(band_name)
            return ee.Feature(None, {"date": img.date().format("YYYY-MM-dd"), band_name.lower(): val})
        feats = coll.map(f)
        vals = safe_get_info(feats.aggregate_array(band_name.lower()), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])
        out = []
        if vals and dates:
            for d,v in zip(dates, vals):
                out.append({"date": d, band_name.lower(): None if v is None else float(v)})
        return out
    except Exception as e:
        logger.warning("generic_index_timeseries failed (%s): %s", collection_id, e)
        return []


def compute_ndvi_evi_gndvi_savi_msavi_arvi_ndwi(region, start_str, end_str):
    """
    Return dict of timeseries for various vegetation indices.
    """
    results = {}
    # NDVI
    results["ndvi_timeseries"] = ndvi_timeseries(region, start_str, end_str)

    # EVI
    try:
        def evi_fn(img):
            return img.expression(
                "2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))",
                {"NIR": img.select("B8"), "RED": img.select("B4"), "BLUE": img.select("B2")},
            ).rename("EVI")
        results["evi_timeseries"] = generic_index_timeseries("COPERNICUS/S2_SR_HARMONIZED", evi_fn, region, start_str, end_str, band_name="EVI")
    except Exception as e:
        logger.warning("EVI generation failed: %s", e)
        results["evi_timeseries"] = []

    # GNDVI: (B8 - B3) / (B8 + B3)  (Green band is B3 for Sentinel-2)
    try:
        def gndvi_fn(img):
            return img.normalizedDifference(["B8", "B3"])
        results["gndvi_timeseries"] = generic_index_timeseries("COPERNICUS/S2_SR_HARMONIZED", gndvi_fn, region, start_str, end_str, band_name="GNDVI")
    except Exception as e:
        logger.warning("GNDVI failed: %s", e)
        results["gndvi_timeseries"] = []

    # SAVI: (1 + L) * (NIR - RED) / (NIR + RED + L), L=0.5
    try:
        def savi_fn(img):
            return img.expression("((1.5)*(NIR - RED) / (NIR + RED + 0.5))", {"NIR": img.select("B8"), "RED": img.select("B4")})
        results["savi_timeseries"] = generic_index_timeseries("COPERNICUS/S2_SR_HARMONIZED", savi_fn, region, start_str, end_str, band_name="SAVI")
    except Exception as e:
        logger.warning("SAVI failed: %s", e)
        results["savi_timeseries"] = []

    # MSAVI: 0.5 * (2*NIR + 1 - sqrt((2*NIR+1)^2 - 8*(NIR-RED)))
    try:
        def msavi_fn(img):
            nir = img.select("B8")
            red = img.select("B4")
            expr = nir.expression("0.5 * (2 * NIR + 1 - sqrt((2 * NIR + 1) ** 2 - 8 * (NIR - RED)))", {"NIR": nir, "RED": red})
            return expr
        results["msavi_timeseries"] = generic_index_timeseries("COPERNICUS/S2_SR_HARMONIZED", msavi_fn, region, start_str, end_str, band_name="MSAVI")
    except Exception as e:
        logger.warning("MSAVI failed: %s", e)
        results["msavi_timeseries"] = []

    # ARVI placeholder (approx) - uses blue band and red, similar to EVI correction:
    try:
        def arvi_fn(img):
            return img.expression("(NIR - (2*RED - BLUE)) / (NIR + (2*RED - BLUE))", {"NIR": img.select("B8"), "RED": img.select("B4"), "BLUE": img.select("B2")})
        results["arvi_timeseries"] = generic_index_timeseries("COPERNICUS/S2_SR_HARMONIZED", arvi_fn, region, start_str, end_str, band_name="ARVI")
    except Exception as e:
        logger.warning("ARVI failed: %s", e)
        results["arvi_timeseries"] = []

    # NDWI (McFeeters) using NIR and SWIR - many variants; here use (G - NIR)/(G + NIR) or (NIR - SWIR)
    try:
        def ndwi_fn(img):
            # Using (NIR - SWIR) / (NIR + SWIR) -> use B8 and B11
            return img.normalizedDifference(["B8", "B11"])
        results["ndwi_timeseries"] = generic_index_timeseries("COPERNICUS/S2_SR_HARMONIZED", ndwi_fn, region, start_str, end_str, band_name="NDWI")
    except Exception as e:
        logger.warning("NDWI failed: %s", e)
        results["ndwi_timeseries"] = []

    return results


def soil_moisture_timeseries(region, start_str, end_str):
    """
    Use ERA5-Land volumetric_soil_water_layer_1 as proxy for soil moisture time series.
    """
    try:
        ds = ee.ImageCollection("ECMWF/ERA5_LAND/HOURLY").filterBounds(region).filterDate(start_str, end_str)
        # aggregate by day (reduce to daily mean)
        def to_daily(img):
            date = img.date().format("YYYY-MM-dd")
            return img.set("date_str", date)
        # create a list of unique dates and compute mean per date
        imgs = ds.map(lambda img: img.select(["volumetric_soil_water_layer_1"]).copyProperties(img, ["system:time_start"]).set("date", img.date().format("YYYY-MM-dd")))
        # Use a reducer to extract mean per image (we'll still return hourly/daily depending on user needs)
        feats = imgs.map(lambda img: ee.Feature(None, {"date": img.date().format("YYYY-MM-dd"), "moisture": img.select("volumetric_soil_water_layer_1").reduceRegion(ee.Reducer.mean(), region, 1000).get("volumetric_soil_water_layer_1")}))
        vals = safe_get_info(feats.aggregate_array("moisture"), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])
        out = []
        if vals and dates:
            for d, v in zip(dates, vals):
                out.append({"date": d, "moisture": None if v is None else float(v)})
        return out
    except Exception as e:
        logger.warning("soil_moisture_timeseries failed: %s", e)
        return []






def rainfall_timeseries(region, start_str, end_str):
    """
    Use CHIRPS daily precipitation dataset (UCSB-CHG/CHIRPS/DAILY).
    """
    try:
        coll = ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY").filterBounds(region).filterDate(start_str, end_str)
        def f(img):
            val = img.select("precipitation").reduceRegion(ee.Reducer.mean(), region, 5000).get("precipitation")
            return ee.Feature(None, {"date": img.date().format("YYYY-MM-dd"), "rain": val})
        feats = coll.map(f)
        vals = safe_get_info(feats.aggregate_array("rain"), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])
        out = []
        if vals and dates:
            for d, v in zip(dates, vals):
                out.append({"date": d, "rain_mm": None if v is None else float(v)})
        return out
    except Exception as e:
        logger.warning("rainfall_timeseries failed: %s", e)
        return []


def weather_time_series(region, start_str, end_str):
    """
    Extract basic weather time series from ERA5-Land / other datasets:
    - temperature (2m), dewpoint, solar radiation, wind components, evapotranspiration
    Returns dict: temperature[], dewpoint[], solar_radiation[], wind_speed[], evapotranspiration[]
    """
    out = {"temperature": [], "dewpoint": [], "solar_radiation": [], "wind_speed": [], "evapotranspiration": []}
    try:
        ds = ee.ImageCollection("ECMWF/ERA5_LAND/HOURLY").filterBounds(region).filterDate(start_str, end_str)
        # For each image create features with keys we want
        def make_feature(img):
            date = img.date().format("YYYY-MM-dd")
            temp = img.select("temperature_2m").reduceRegion(ee.Reducer.mean(), region, 1000).get("temperature_2m")
            dew = img.select("dewpoint_temperature_2m").reduceRegion(ee.Reducer.mean(), region, 1000).get("dewpoint_temperature_2m")
            solar = img.select("surface_solar_radiation_downwards").reduceRegion(ee.Reducer.mean(), region, 1000).get("surface_solar_radiation_downwards")
            # compute wind speed from u and v
            u = img.select("u_component_of_wind_10m").reduceRegion(ee.Reducer.mean(), region, 1000).get("u_component_of_wind_10m")
            v = img.select("v_component_of_wind_10m").reduceRegion(ee.Reducer.mean(), region, 1000).get("v_component_of_wind_10m")
            # evapotranspiration proxies: many variables; try potential_evaporation_hourly or total_evaporation
            evap = None
            try:
                evap = img.select("potential_evaporation_hourly").reduceRegion(ee.Reducer.mean(), region, 1000).get("potential_evaporation_hourly")
            except Exception:
                try:
                    evap = img.select("total_evaporation_hourly").reduceRegion(ee.Reducer.mean(), region, 1000).get("total_evaporation_hourly")
                except Exception:
                    evap = None
            return ee.Feature(None, {"date": date, "temp": temp, "dewpoint": dew, "solar": solar, "u": u, "v": v, "evap": evap})
        feats = ds.map(make_feature)
        # extract arrays
        temp_vals = safe_get_info(feats.aggregate_array("temp"), default=[])
        dew_vals = safe_get_info(feats.aggregate_array("dewpoint"), default=[])
        solar_vals = safe_get_info(feats.aggregate_array("solar"), default=[])
        u_vals = safe_get_info(feats.aggregate_array("u"), default=[])
        v_vals = safe_get_info(feats.aggregate_array("v"), default=[])
        evap_vals = safe_get_info(feats.aggregate_array("evap"), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])
        if dates:
            for i, d in enumerate(dates):
                temp = temp_vals[i] if i < len(temp_vals) else None
                dew = dew_vals[i] if i < len(dew_vals) else None
                solar = solar_vals[i] if i < len(solar_vals) else None
                u = u_vals[i] if i < len(u_vals) else None
                v = v_vals[i] if i < len(v_vals) else None
                evap = evap_vals[i] if i < len(evap_vals) else None
                wind_speed = None
                if u is not None and v is not None:
                    try:
                        wind_speed = math.sqrt(float(u) ** 2 + float(v) ** 2)
                    except Exception:
                        wind_speed = None
                out["temperature"].append({"date": d, "temp": None if temp is None else float(temp)})
                out["dewpoint"].append({"date": d, "dewpoint": None if dew is None else float(dew)})
                out["solar_radiation"].append({"date": d, "solar": None if solar is None else float(solar)})
                out["wind_speed"].append({"date": d, "wind_speed": None if wind_speed is None else float(wind_speed)})
                out["evapotranspiration"].append({"date": d, "evap": None if evap is None else float(evap)})
        return out
    except Exception as e:
        logger.warning("weather_time_series failed: %s", e)
        return out


def lai_timeseries_modis(region, start_str, end_str):
    """
    Use MODIS MCD15A3H (LAI) or MCD15A2H - these have different temporal resolutions.
    Try "MODIS/061/MCD15A3H" or "MODIS/006/MYD15A3H" depending on availability.
    """
    try:
        # try MCD15A3H first (shorter temporal resolution)
        coll_id_candidates = ["MODIS/006/MCD15A2H", "MODIS/006/MCD15A3H", "MODIS/061/MCD15A3H"]
        coll = None
        used = None
        for cid in coll_id_candidates:
            try:
                _coll = ee.ImageCollection(cid).filterBounds(region).filterDate(start_str, end_str)
                # quick check
                sample = safe_get_info(_coll.first(), default=None)
                if sample:
                    coll = _coll
                    used = cid
                    break
            except Exception:
                continue
        if not coll:
            logger.warning("LAI dataset not available in this Earth Engine account.")
            return []
        # MODIS LAI band sometimes named "Lai" or "Lai_500m" etc. Try common names:
        def pick_lai(img):
            bn = img.bandNames()
            # choose first numeric band (prefer band names that contain 'Lai' or 'LAI')
            bns = safe_get_info(bn, [])
            chosen = None
            for b in bns:
                if "Lai" in b or "LAI" in b or b.lower().startswith("lai"):
                    chosen = b
                    break
            if chosen is None and bns:
                chosen = bns[0]
            return img.select([chosen]).rename("LAI")
        coll2 = coll.map(lambda img: pick_lai(img))
        def f(img):
            v = img.select("LAI").reduceRegion(ee.Reducer.mean(), region, 500).get("LAI")
            return ee.Feature(None, {"date": img.date().format("YYYY-MM-dd"), "lai": v})
        feats = coll2.map(f)
        vals = safe_get_info(feats.aggregate_array("lai"), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])
        out = []
        if vals and dates:
            for d, v in zip(dates, vals):
                out.append({"date": d, "lai": None if v is None else float(v)})
        return out
    except Exception as e:
        logger.warning("lai_timeseries_modis failed: %s", e)
        return []


# def compute_topography(region):
#     """
#     Extract elevation, slope, aspect from SRTM (or other DEM).
#     """
#     try:
#         dem = ee.Image("USGS/SRTMGL1_003")
#         elev = dem.reduceRegion(ee.Reducer.mean(), region, 30).get("elevation")
#         slope = ee.Terrain.slope(dem).reduceRegion(ee.Reducer.mean(), region, 30).get("slope")
#         aspect = ee.Terrain.aspect(dem).reduceRegion(ee.Reducer.mean(), region, 30).get("aspect")
#         info = {}
#         elev_i = safe_get_info(elev, default=None)
#         slope_i = safe_get_info(slope, default=None)
#         aspect_i = safe_get_info(aspect, default=None)
#         info["elevation_m"] = None if elev_i is None else float(elev_i)
#         info["slope_deg"] = None if slope_i is None else float(slope_i)
#         info["aspect_deg"] = None if aspect_i is None else float(aspect_i)
#         return info
#     except Exception as e:
#         logger.warning("compute_topography failed: %s", e)
#         return {"elevation_m": None, "slope_deg": None, "aspect_deg": None}


def compute_ndvi_trend(region, start_str, end_str):
    """
    Compute a very simple linear trend on NDVI timeseries (slope per day).
    Returns (slope, intercept) or (None, None)
    """
    try:
        ts = ndvi_timeseries(region, start_str, end_str)
        if not ts or len(ts) < 2:
            return (None, None)
        # dates to ordinal days
        xs = []
        ys = []
        for t in ts:
            try:
                dt = datetime.datetime.strptime(t["date"], "%Y-%m-%d")
                xs.append(dt.toordinal())
                ys.append(t["ndvi"] if t["ndvi"] is not None else float("nan"))
            except Exception:
                continue
        # filter valid pairs
        pairs = [(x, y) for x, y in zip(xs, ys) if y is not None and not math.isnan(y)]
        if len(pairs) < 2:
            return (None, None)
        xs2 = [p[0] for p in pairs]
        ys2 = [p[1] for p in pairs]
        # linear regression slope & intercept
        n = len(xs2)
        mean_x = mean(xs2)
        mean_y = mean(ys2)
        num = sum((xi - mean_x) * (yi - mean_y) for xi, yi in zip(xs2, ys2))
        den = sum((xi - mean_x) ** 2 for xi in xs2)
        if den == 0:
            return (None, None)
        slope = num / den
        intercept = mean_y - slope * mean_x
        # convert slope from per ordinal day to per day (ordinal is days) -> slope remains per day
        return (float(slope), float(intercept))
    except Exception as e:
        logger.warning("compute_ndvi_trend failed: %s", e)
        return (None, None)


# ---------- Robust LAI, Canopy, Chlorophyll, WSI helpers ----------
def get_lai_timeseries_safe(region, start_date, end_date):
    """
    LAI timeseries from MODIS (tries several MODIS collections and band name fallbacks).
    Returns list of {date, lai} or [].
    """
    try:
        candidates = [
            "MODIS/061/MCD15A3H",
            "MODIS/006/MCD15A3H",
            "MODIS/006/MCD15A2H",
            "MODIS/061/MCD15A2H"
        ]
        coll = None
        used = None
        for cid in candidates:
            try:
                _coll = ee.ImageCollection(cid).filterBounds(region).filterDate(start_date, end_date)
                # quick check if any images
                first = safe_get_info(_coll.first(), default=None)
                if first:
                    coll = _coll
                    used = cid
                    break
            except Exception:
                continue
        if not coll:
            logger.warning("LAI: no MODIS collection found/accessible.")
            return []

        # choose a LAI band by inspecting band names of first image
        first_img = coll.first()
        bn = safe_get_info(first_img.bandNames(), default=[])
        chosen = None
        for b in bn:
            if "lai" in b.lower() or "Lai" in b or "LAI" in b:
                chosen = b
                break
        if not chosen and bn:
            chosen = bn[0]

        def fmt(img):
            date = img.date().format("YYYY-MM-dd")
            val = img.select([chosen]).reduceRegion(ee.Reducer.mean(), region, 500).get(chosen)
            return ee.Feature(None, {"date": date, "lai": val})

        feats = coll.map(fmt)
        vals = safe_get_info(feats.aggregate_array("lai"), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])
        out = []
        if vals and dates:
            for d, v in zip(dates, vals):
                out.append({"date": d, "lai": None if v is None else float(v)})
        logger.info("LAI: returned %d points (source=%s, band=%s)", len(out), used, chosen)
        return out
    except Exception as e:
        logger.warning("get_lai_timeseries_safe failed: %s", e)
        return []


def get_canopy_fraction_safe(region, start_date, end_date):
    """
    Estimate canopy fraction using MODIS FPAR/FPAR or LAI proxies.
    Returns list of {date, canopy_frac} or [].
    """
    try:
        candidates = [
            "MODIS/061/MCD15A3H",  # contains Fpar / fpar
            "MODIS/006/MCD15A3H",
            "MODIS/006/MCD15A2H"
        ]
        coll = None
        used = None
        band_candidate_names = ["Fpar", "FPAR", "Fpar_500m", "fpar"]
        for cid in candidates:
            try:
                _coll = ee.ImageCollection(cid).filterBounds(region).filterDate(start_date, end_date)
                first = safe_get_info(_coll.first(), default=None)
                if first:
                    coll = _coll
                    used = cid
                    break
            except Exception:
                continue
        if not coll:
            logger.warning("Canopy fraction: MODIS FPAR not accessible.")
            return []

        # pick band
        first_img = coll.first()
        bnames = safe_get_info(first_img.bandNames(), default=[])
        chosen = None
        for b in band_candidate_names:
            for bn in bnames:
                if b.lower() in bn.lower():
                    chosen = bn
                    break
            if chosen:
                break
        if not chosen and bnames:
            chosen = bnames[0]

        def fmt(img):
            date = img.date().format("YYYY-MM-dd")
            val = img.select([chosen]).reduceRegion(ee.Reducer.mean(), region, 500).get(chosen)
            return ee.Feature(None, {"date": date, "canopy_frac": val})

        feats = coll.map(fmt)
        vals = safe_get_info(feats.aggregate_array("canopy_frac"), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])
        out = []
        for d, v in zip(dates, vals):
            out.append({"date": d, "canopy_frac": None if v is None else float(v)})
        logger.info("Canopy fraction: returned %d points (source=%s, band=%s)", len(out), used, chosen)
        return out
    except Exception as e:
        logger.warning("get_canopy_fraction_safe failed: %s", e)
        return []


def get_chlorophyll_index_safe(region, start_date, end_date):
    """
    Compute a chlorophyll proxy (MTCI or similar) from Sentinel-2.
    Returns list of {date, chlorophyll} or [].
    """
    try:
        coll = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(region).filterDate(start_date, end_date)
        try:
            coll = coll.filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
        except Exception:
            pass

        # expression using red-edge (B5), red (B4) and NIR (B8): MTCI = (B8 - B5) / (B5 - B4)
        def add_index(img):
            # ensure bands exist -- wrap in try so missing bands don't crash whole mapping
            try:
                expr = img.expression("(B8 - B5) / (B5 - B4)", {"B8": img.select("B8"), "B5": img.select("B5"), "B4": img.select("B4")}).rename("chlorophyll")
                return img.addBands(expr)
            except Exception:
                # fallback attempt: normalized diff NIR-RED (a simple proxy)
                try:
                    expr2 = img.normalizedDifference(["B8", "B4"]).rename("chlorophyll")
                    return img.addBands(expr2)
                except Exception:
                    return img

        coll2 = coll.map(add_index)
        def fmt(img):
            date = img.date().format("YYYY-MM-dd")
            val = img.select("chlorophyll").reduceRegion(ee.Reducer.mean(), region, 20).get("chlorophyll")
            return ee.Feature(None, {"date": date, "chlorophyll": val})
        feats = coll2.map(fmt)
        vals = safe_get_info(feats.aggregate_array("chlorophyll"), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])
        out = []
        for d, v in zip(dates, vals):
            out.append({"date": d, "chlorophyll": None if v is None else float(v)})
        logger.info("Chlorophyll: returned %d points", len(out))
        return out
    except Exception as e:
        logger.warning("get_chlorophyll_index_safe failed: %s", e)
        return []


def get_wsi_timeseries_safe(region, start_date, end_date, agg="daily"):
    """
    Compute a simple Water Stress Index (WSI) = skin_temperature - air_temperature_2m.
    Returns list of {date, wsi} where wsi is in Kelvin difference; also includes wsi_c if you want Celsius difference.
    """
    try:
        # prefer ERA5-Land hourly or daily aggregated if present
        coll_candidates = ["ECMWF/ERA5_LAND/HOURLY", "ECMWF/ERA5_LAND/DAILY"]
        coll = None
        used = None
        for cid in coll_candidates:
            try:
                _coll = ee.ImageCollection(cid).filterBounds(region).filterDate(start_date, end_date)
                first = safe_get_info(_coll.first(), default=None)
                if first:
                    coll = _coll
                    used = cid
                    break
            except Exception:
                continue
        if not coll:
            logger.warning("WSI: ERA5-Land not accessible.")
            return []

        # make features
        def fmt(img):
            date = img.date().format("YYYY-MM-dd")
            # skin temperature band might be 'skin_temperature' or similar
            skin = None
            air = None
            try:
                skin = img.select("skin_temperature").reduceRegion(ee.Reducer.mean(), region, 1000).get("skin_temperature")
            except Exception:
                # try alt name
                try:
                    skin = img.select("surface_temperature").reduceRegion(ee.Reducer.mean(), region, 1000).get("surface_temperature")
                except Exception:
                    skin = None
            try:
                air = img.select("temperature_2m").reduceRegion(ee.Reducer.mean(), region, 1000).get("temperature_2m")
            except Exception:
                air = None
            wsi_val = None
            if skin is not None and air is not None:
                try:
                    wsi_val = ee.Number(skin).subtract(ee.Number(air))
                except Exception:
                    wsi_val = None
            return ee.Feature(None, {"date": date, "wsi": wsi_val})

        feats = coll.map(fmt)
        vals = safe_get_info(feats.aggregate_array("wsi"), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])
        out = []
        for d, v in zip(dates, vals):
            if v is None:
                out.append({"date": d, "wsi": None})
            else:
                try:
                    w = float(v)
                    out.append({"date": d, "wsi": w, "wsi_c": w})  # difference in K (same numeric for °C-K difference)
                except Exception:
                    out.append({"date": d, "wsi": None})
        logger.info("WSI: returned %d points (source=%s)", len(out), used)
        return out
    except Exception as e:
        logger.warning("get_wsi_timeseries_safe failed: %s", e)
        return []



def get_canopy_temperature_safe(region, start, end):
    """Compute canopy (skin) temperature time series from ERA5."""
    try:
        coll = (ee.ImageCollection("ECMWF/ERA5_LAND/HOURLY")
                .filterBounds(region)
                .filterDate(start, end))

        def extract(img):
            val = img.select("skin_temperature").reduceRegion(
                ee.Reducer.mean(), region, 1000
            ).get("skin_temperature")
            return ee.Feature(None, {
                "date": img.date().format("YYYY-MM-dd"),
                "canopy_temp": val
            })

        feats = coll.map(extract)
        temps = safe_get_info(feats.aggregate_array("canopy_temp"), default=[])
        dates = safe_get_info(feats.aggregate_array("date"), default=[])

        out = []
        if temps and dates:
            for d, v in zip(dates, temps):
                out.append({"date": d, "canopy_temp": None if v is None else float(v) - 273.15})  
                # Kelvin → °C
        return out
    except Exception as e:
        logger.warning("Canopy temperature extraction failed: %s", e)
        return []



def compute_ml_features_from_response(resp):
    """
    Build feature list exactly in same order as used during training:
    ["ndvi_mean","ndvi_std","ndvi_last","ndvi_slope",
     "soil_moisture_mean","rainfall_mean","temp_mean",
     "canopy_temp_mean","lai_mean","wsi_mean"]
    """
    import numpy as np
    from datetime import datetime

    def mean_of(ts, key):
        vals = [p.get(key) for p in ts if p.get(key) is not None]
        return float(np.mean(vals)) if vals else None

    def std_of(ts, key):
        vals = [p.get(key) for p in ts if p.get(key) is not None]
        return float(np.std(vals)) if vals else None

    def last_of(ts, key):
        vals = [p.get(key) for p in ts if p.get(key) is not None]
        return float(vals[-1]) if vals else None

    def slope_of(ts, key):
        dates, vals = [], []
        for p in ts:
            d, v = p.get("date"), p.get(key)
            if d and v is not None:
                try:
                    dt = datetime.strptime(d, "%Y-%m-%d").toordinal()
                    dates.append(dt)
                    vals.append(float(v))
                except Exception:
                    continue
        if len(dates) < 2:
            return None
        try:
            coeffs = np.polyfit(dates, vals, 1)
            return float(coeffs[0])
        except Exception:
            return None

    ndvi_ts = resp.get("ndvi_timeseries", [])
    soil_moisture_ts = resp.get("soil_moisture", [])
    rainfall_ts = resp.get("rainfall", [])
    temp_ts = resp.get("temperature", [])
    canopy_ts = resp.get("canopy_temperature", [])
    lai_ts = resp.get("lai_timeseries", [])
    wsi_ts = resp.get("wsi_timeseries", []) or resp.get("wsi_mean", [])

    features = [
        mean_of(ndvi_ts, "ndvi"),
        std_of(ndvi_ts, "ndvi"),
        last_of(ndvi_ts, "ndvi"),
        slope_of(ndvi_ts, "ndvi"),
        mean_of(soil_moisture_ts, "moisture"),
        mean_of(rainfall_ts, "rain_mm"),
        mean_of(temp_ts, "temp"),
        mean_of(canopy_ts, "canopy_temp"),
        mean_of(lai_ts, "lai"),
        mean_of(wsi_ts, "wsi"),
    ]
    return features



# ---------- API Endpoint ----------

@app.route("/analytics", methods=["POST"])
def analytics():
    if not EE_AVAILABLE:
        logger.warning("analytics_unified: Earth Engine not initialized; returning error.")
        return jsonify({"error": "Earth Engine is not initialized on the server. Run `earthengine authenticate` locally or configure service account and set EE_SA_EMAIL and EE_SA_KEY_PATH."}), 500

    try:
        data = request.get_json(force=True)
        coords = data.get("coordinates")
        start_str = data.get("start_date")
        end_str = data.get("end_date")
        farm_id = data.get("farm_id")

            # ----------------- CACHE CHECK -----------------
        force_refresh = bool(data.get("force_refresh"))
        try:
                cache = _load_cache()
                cache_key = _make_cache_key(coords, start_str, end_str, farm_id)
                cached = cache.get(cache_key)
                if cached and not force_refresh:
                   ts = cached.get("_cached_at_ts")
                if ts:
                    age = datetime.datetime.utcnow().timestamp() - float(ts)
                    if age <= CACHE_TTL_SECONDS:
                        logger.info("Serving analytics from cache (key=%s, age=%ds)", cache_key, int(age))
                        return jsonify(cached.get("response")), 200
                    else:
                        logger.info("Cache expired for key=%s (age=%ds)", cache_key, int(age))
        except Exception as e:
            logger.warning("Analytics cache check failed: %s", e)
    # ------------------------------------------------

        if not coords:
            return jsonify({"error": "No coordinates provided"}), 400

        # default dates
        if not start_str or not end_str:
            end_date = datetime.date.today()
            start_date = end_date - datetime.timedelta(days=90)
            start_str = start_date.strftime("%Y-%m-%d")
            end_str = end_date.strftime("%Y-%m-%d")

        logger.info("Analytics request for coords (len=%s) between %s and %s",
                    len(coords) if isinstance(coords, list) else "?", start_str, end_str)
        region = polygon_from_coords(coords)

        # compute multiple analytics in try blocks to isolate failures
        response = {"start_date": start_str, "end_date": end_str}

        # Vegetation indices timeseries
        veg_indices = compute_ndvi_evi_gndvi_savi_msavi_arvi_ndwi(region, start_str, end_str)
        response.update(veg_indices)

        # Soil moisture timeseries
        response["soil_moisture"] = soil_moisture_timeseries(region, start_str, end_str)

        # Soil temperature (ERA5 soil_temperature_level_1)
        try:
            st = []
            coll = ee.ImageCollection("ECMWF/ERA5_LAND/HOURLY").filterBounds(region).filterDate(start_str, end_str)

            def st_feat(img):
                val = img.select("soil_temperature_level_1").reduceRegion(
                    ee.Reducer.mean(), region, 1000).get("soil_temperature_level_1")
                return ee.Feature(None, {"date": img.date().format("YYYY-MM-dd"), "soil_temp": val})

            st_feats = coll.map(st_feat)
            st_vals = safe_get_info(st_feats.aggregate_array("soil_temp"), default=[])
            st_dates = safe_get_info(st_feats.aggregate_array("date"), default=[])
            if st_vals and st_dates:
                for d, v in zip(st_dates, st_vals):
                    st.append({"date": d, "soil_temp": None if v is None else float(v)})
            response["soil_temperature"] = st
        except Exception as e:
            logger.warning("soil_temperature extraction failed: %s", e)
            response["soil_temperature"] = []

        # Rainfall
        response["rainfall"] = rainfall_timeseries(region, start_str, end_str)

        # Weather (temp, dewpoint, solar, wind, evap)
        weather = weather_time_series(region, start_str, end_str)
        response.update(weather)

        # === New features added here ===
        try:
            response["lai_timeseries"] = get_lai_timeseries_safe(region, start_str, end_str)
        except Exception as e:
            logger.warning("LAI extraction failed: %s", e)
            response["lai_timeseries"] = []

        try:
            response["canopy_fraction"] = get_canopy_fraction_safe(region, start_str, end_str)
        except Exception as e:
            logger.warning("Canopy fraction extraction failed: %s", e)
            response["canopy_fraction"] = []

        try:
            response["chlorophyll_index"] = get_chlorophyll_index_safe(region, start_str, end_str)
        except Exception as e:
            logger.warning("Chlorophyll extraction failed: %s", e)
            response["chlorophyll_index"] = []

        try:
            response["water_stress_index"] = get_wsi_timeseries_safe(region, start_str, end_str)
        except Exception as e:
            logger.warning("WSI extraction failed: %s", e)
            response["water_stress_index"] = []
        # === End of new features ===

  
        try:
            response["canopy_temperature"] = get_canopy_temperature_safe(region, start_str, end_str)
        except Exception as e:
            logger.warning("Canopy temperature failed: %s", e)
            response["canopy_temperature"] = []

        # =======================
        # ML Prediction Section
        # =======================
        try:
            if ml_model is not None:
                features = compute_ml_features_from_response(response)

                safe_features = [0 if f is None or (isinstance(f, float) and np.isnan(f)) else f for f in features]

                try:
                    pred = ml_model.predict([safe_features])[0]
                    response["ml_prediction"] = pred

                    # Optional: add confidence if available
                    if hasattr(ml_model, "predict_proba"):
                        probas = ml_model.predict_proba([safe_features])[0]
                        response["ml_confidence"] = float(max(probas))

                    print(f"🤖 ML Prediction: {pred}")
                except Exception as ex:
                    print(f"⚠️ ML prediction failed: {ex}")
            else:
                print("⚠️ ML model not loaded, skipping prediction.")
        except Exception as e:
            print(f"⚠️ ML prediction failed: {e}")
# =======================

      

        logger.info("Unified analytics computed: keys=%s", list(response.keys()))

# ----------------- SAVE TO CACHE -----------------
        try:
            cache = _load_cache()
            cache_key = _make_cache_key(coords, start_str, end_str, farm_id)
            cache[cache_key] = {
                "_cached_at_ts": datetime.datetime.now(datetime.UTC).timestamp(),
                "response": response
            }
            _save_cache(cache)
            logger.info("Analytics saved to cache (key=%s)", cache_key)
        except Exception as e:
            logger.warning("Failed to save analytics to cache: %s", e)
# -------------------------------------------------

        return jsonify(response)


    except Exception as e:
        logger.exception("❌ Error in /analytics:")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    # run server
    app.run(host="0.0.0.0", port=5005, debug=True)












