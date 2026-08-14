"""Live weather lookups via Open-Meteo — free, no API key, no signup.

Exposed to the model as a tool so it only fires when weather actually comes up, rather
than adding latency or cost to ordinary turns.
"""

import os

import httpx

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# Where to look when the user just says "what's the weather?" without naming a place.
DEFAULT_LOCATION = os.getenv("AURA_DEFAULT_LOCATION", "").strip()
UNITS = os.getenv("AURA_WEATHER_UNITS", "metric").strip().lower()
IS_METRIC = UNITS != "imperial"

TIMEOUT = 8.0

# WMO weather interpretation codes used by Open-Meteo.
WEATHER_CODES = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "foggy",
    48: "freezing fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    56: "freezing drizzle",
    57: "heavy freezing drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    66: "freezing rain",
    67: "heavy freezing rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    77: "snow grains",
    80: "light rain showers",
    81: "rain showers",
    82: "violent rain showers",
    85: "light snow showers",
    86: "heavy snow showers",
    95: "a thunderstorm",
    96: "a thunderstorm with hail",
    99: "a severe thunderstorm with hail",
}


def _describe(code) -> str:
    try:
        return WEATHER_CODES.get(int(code), "unclear conditions")
    except (TypeError, ValueError):
        return "unclear conditions"


async def _geocode(client: httpx.AsyncClient, place: str):
    resp = await client.get(
        GEOCODE_URL, params={"name": place, "count": 1, "language": "en", "format": "json"}
    )
    resp.raise_for_status()
    results = (resp.json() or {}).get("results") or []
    if not results:
        return None
    top = results[0]
    label = ", ".join(
        str(p) for p in (top.get("name"), top.get("admin1"), top.get("country")) if p
    )
    return top["latitude"], top["longitude"], label


async def get_weather(location: str = "") -> str:
    place = (location or "").strip() or DEFAULT_LOCATION
    if not place:
        return (
            "No location known. Ask the user which city they're in, and once they say, "
            "use remember_fact to save it so you don't have to ask again."
        )

    temp_unit = "celsius" if IS_METRIC else "fahrenheit"
    wind_unit = "kmh" if IS_METRIC else "mph"
    deg = "°C" if IS_METRIC else "°F"
    speed = "km/h" if IS_METRIC else "mph"

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            found = await _geocode(client, place)
            if not found:
                return f"Couldn't find anywhere called '{place}'. Ask the user to clarify."
            lat, lon, label = found

            resp = await client.get(
                FORECAST_URL,
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
                    "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                    "timezone": "auto",
                    "forecast_days": 1,
                    "temperature_unit": temp_unit,
                    "wind_speed_unit": wind_unit,
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        print(f"[aura] weather lookup failed: {exc}")
        return f"Weather lookup failed ({type(exc).__name__}). Tell the user it's unavailable right now."

    cur = data.get("current") or {}
    daily = data.get("daily") or {}

    def first(key):
        vals = daily.get(key) or []
        return vals[0] if vals else None

    parts = [f"Weather for {label}:"]
    if cur.get("temperature_2m") is not None:
        parts.append(f"currently {round(cur['temperature_2m'])}{deg}")
    if cur.get("weather_code") is not None:
        parts.append(_describe(cur["weather_code"]))
    if cur.get("apparent_temperature") is not None:
        parts.append(f"feels like {round(cur['apparent_temperature'])}{deg}")
    if cur.get("wind_speed_10m") is not None:
        parts.append(f"wind {round(cur['wind_speed_10m'])} {speed}")

    hi, lo = first("temperature_2m_max"), first("temperature_2m_min")
    if hi is not None and lo is not None:
        parts.append(f"today {round(lo)}–{round(hi)}{deg}")
    rain = first("precipitation_probability_max")
    if rain is not None:
        parts.append(f"{round(rain)}% chance of precipitation")

    summary = parts[0] + " " + ", ".join(parts[1:]) + "."
    print(f"[aura] {summary}")
    return summary


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": (
                "Look up the current weather and today's forecast for a place. Use this "
                "whenever the user asks about weather, temperature, rain, or whether they "
                "need a coat. Never guess weather from memory — always call this."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": (
                            "City to check, e.g. 'Cape Town' or 'Leeds, UK'. Leave empty "
                            "to use the user's known/default location."
                        ),
                    }
                },
            },
        },
    }
]


async def run_tool(name: str, args: dict) -> str:
    if name == "get_weather":
        return await get_weather(args.get("location", ""))
    return "unknown tool"
