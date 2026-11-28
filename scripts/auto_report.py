import argparse
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests
import yfinance as yf
from google import genai
from google.genai import types

KST = timezone(timedelta(hours=9))
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"].strip()
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"].strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-4-hydrogen")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPOSITORY", "busychronicler7800/busychronicler7800.github.io")

if SUPABASE_KEY.startswith("sb_publishable_"):
    raise RuntimeError(
        "SUPABASE_SERVICE_ROLE_KEY에 공개용 키(sb_publishable_...)가 들어가 있습니다. "
        "Supabase Project Settings > API Keys의 Secret key(sb_secret_... 또는 service_role JWT)로 교체해 주세요."
    )

SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Content-Type": "application/json",
}
if SUPABASE_KEY.startswith("eyJ"):
    SB_HEADERS["Authorization"] = f"Bearer {SUPABASE_KEY}"

WEEKDAYS_KO = ["월", "화", "수", "목", "금", "토", "일"]

WMO_WEATHER_KO = {
    0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림",
    45: "안개", 48: "서리 안개", 51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비",
    61: "약한 비", 63: "비", 65: "강한 비", 71: "약한 눈", 73: "눈", 75: "강한 눈",
    80: "약한 소나기", 81: "소나기", 82: "강한 소나기", 95: "뇌우",
}

METNO_SYMBOL_KO = {
    "clearsky": "맑음",
    "fair": "대체로 맑음",
    "partlycloudy": "구름 조금",
    "cloudy": "흐림",
    "fog": "안개",
    "lightrain": "약한 비",
    "rain": "비",
    "heavyrain": "강한 비",
    "lightrainshowers": "약한 소나기",
    "rainshowers": "소나기",
    "lightsnow": "약한 눈",
    "snow": "눈",
    "sleet": "진눈깨비",
}

DEFAULT_ROADMAP_CONTEXT = """[프로젝트 현재 기반 및 예정 로드맵]
- 완료 기반: busychronicler7800.github.io(커스텀 도메인 미보유) 5개 모듈 분리, PC·모바일 간 Supabase DB 읽음 동기화(날짜 단일 키 YYYY-MM-DD)·점멸 알림 점, cron-job.org 정시 트리거 + GitHub Actions + Gemini 4 Hydrogen 무료 자동 적재 파이프라인(생성 모델 표시·3중 날씨 폴백·심야 작업 이월 반영).
- 다음 예정 작업:
  1) 3단계 구글 타임라인 지도 탭 신설: 스마트폰 타임라인 JSON 일괄 업로드 파서 및 관리자 전용 Leaflet.js 모노크롬 이동거리 지도 구현.
  2) 2단계 B-2 키움증권 잔고 자동화: 현재 키움증권 미연동(연동 대기) 상태. 국내 중개형 ISA REST API 연동 + 해외 위탁 체결 메일(Gmail) 파싱으로 portfolio_holdings 자동 갱신.
- 궁극적 목표 (모든 리포트에서 지속 발전 방향 제시):
  동일한 리포트 1본을 [리포트 자동 제작 → 웹사이트 자동 게시(가독성 고도화) → 아이폰/아이패드 앱 푸시 알림(클릭 시 바로 리포트 열람)]으로 단일 통합하는 파이프라인 구축."""


def sb_select(table: str, params: dict) -> list:
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SB_HEADERS, params=params, timeout=20)
    if not r.ok:
        raise RuntimeError(f"Supabase SELECT failed [{table}] ({r.status_code}): {r.text}")
    return r.json()


def sb_upsert(table: str, conflict_col: str, payload: dict) -> None:
    headers = {**SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"}
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=headers,
        params={"on_conflict": conflict_col},
        json=payload,
        timeout=20,
    )
    if not r.ok:
        raise RuntimeError(f"Supabase UPSERT failed [{table}] ({r.status_code}): {r.text}")


def build_dynamic_context() -> str:
    try:
        rows = sb_select(
            "report_config",
            {"select": "roadmap_context,extra_instructions", "id": "eq.1", "limit": 1},
        )
        if rows:
            roadmap = (rows[0].get("roadmap_context") or "").strip() or DEFAULT_ROADMAP_CONTEXT
            extra = (rows[0].get("extra_instructions") or "").strip()
            print("[OK] Loaded report_config from Supabase")
            if extra:
                return f"{roadmap}\n\n[관리자 실시간 추가 지침 (웹사이트 report_config)]\n{extra}"
            return roadmap
    except Exception as e:
        print(f"[WARN] report_config fetch failed, using default: {e}")
    return DEFAULT_ROADMAP_CONTEXT


def fetch_quote(symbol: str) -> dict:
    try:
        hist = yf.Ticker(symbol).history(period="5d")
        closes = hist["Close"].dropna()
        if len(closes) == 0:
            return {"price": None, "change_pct": 0.0, "date": ""}
        last_price = float(closes.iloc[-1])
        prev_price = float(closes.iloc[-2]) if len(closes) >= 2 else last_price
        change_pct = ((last_price - prev_price) / prev_price * 100.0) if prev_price else 0.0
        last_date = str(closes.index[-1])[:10]
        return {"price": round(last_price, 2), "change_pct": round(change_pct, 2), "date": last_date}
    except Exception as e:
        print(f"[WARN] quote fetch failed for {symbol}: {e}")
        return {"price": None, "change_pct": 0.0, "date": ""}


def fetch_pyeongtaek_weather() -> dict:
    today_str = datetime.now(KST).strftime("%Y-%m-%d")

    for attempt in range(1, 3):
        try:
            r = requests.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": 36.9921,
                    "longitude": 127.1129,
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                    "timezone": "Asia/Seoul",
                    "forecast_days": 1,
                },
                headers={"User-Agent": "busychronicler7800.github.io/1.0"},
                timeout=15,
            )
            r.raise_for_status()
            daily = r.json().get("daily", {})
            min_c = daily.get("temperature_2m_min", [None])[0]
            max_c = daily.get("temperature_2m_max", [None])[0]
            if min_c is not None and max_c is not None:
                code = int(daily.get("weather_code", [0])[0])
                rain_pct = daily.get("precipitation_probability_max", [0])[0]
                print(f"[OK] Weather fetched from Open-Meteo: {min_c}C ~ {max_c}C")
                return {
                    "source": "Open-Meteo",
                    "desc": WMO_WEATHER_KO.get(code, f"날씨코드 {code}"),
                    "min_c": round(float(min_c), 1),
                    "max_c": round(float(max_c), 1),
                    "diurnal_range_c": round(float(max_c) - float(min_c), 1),
                    "rain_pct": rain_pct,
                }
        except Exception as e:
            print(f"[WARN] Open-Meteo attempt {attempt} failed: {e}")
            if attempt == 1:
                time.sleep(2)

    try:
        r = requests.get(
            "https://api.met.no/weatherapi/locationforecast/2.0/compact",
            params={"lat": 36.9921, "lon": 127.1129},
            headers={"User-Agent": "busychronicler7800.github.io/1.0 (https://busychronicler7800.github.io)"},
            timeout=15,
        )
        r.raise_for_status()
        series = r.json().get("properties", {}).get("timeseries", [])
        temps = []
        max_precip_mm = 0.0
        symbol_code = ""
        for entry in series[:30]:
            ts = entry.get("time", "")
            dt_kst = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(KST)
            if dt_kst.strftime("%Y-%m-%d") != today_str and len(temps) >= 6:
                continue
            inst = entry.get("data", {}).get("instant", {}).get("details", {})
            if "air_temperature" in inst:
                temps.append(float(inst["air_temperature"]))
            next_block = entry.get("data", {}).get("next_6_hours") or entry.get("data", {}).get("next_1_hours") or {}
            precip = next_block.get("details", {}).get("precipitation_amount")
            if precip is not None:
                max_precip_mm = max(max_precip_mm, float(precip))
            if not symbol_code:
                symbol_code = next_block.get("summary", {}).get("symbol_code", "")
        if temps:
            min_c, max_c = round(min(temps), 1), round(max(temps), 1)
            base_sym = symbol_code.split("_")[0]
            desc = METNO_SYMBOL_KO.get(base_sym, "구름 조금")
            rain_pct = 70 if max_precip_mm >= 1.0 else (30 if max_precip_mm > 0 else 10)
            print(f"[OK] Weather fetched from MET Norway: {min_c}C ~ {max_c}C")
            return {
                "source": "MET Norway",
                "desc": desc,
                "min_c": min_c,
                "max_c": max_c,
                "diurnal_range_c": round(max_c - min_c, 1),
                "rain_pct": rain_pct,
            }
    except Exception as e:
        print(f"[WARN] MET Norway failed: {e}")

    try:
        r = requests.get(
            "https://wttr.in/Pyeongtaek",
            params={"format": "j1"},
            headers={"User-Agent": "curl/8.0"},
            timeout=15,
        )
        r.raise_for_status()
        day = r.json().get("weather", [{}])[0]
        min_c = float(day["mintempC"])
        max_c = float(day["maxtempC"])
        hourly = day.get("hourly", [])
        rain_pct = max([int(h.get("chanceofrain", 0)) for h in hourly], default=0)
        desc_en = (hourly[4].get("weatherDesc", [{}])[0].get("value", "") if len(hourly) > 4 else "")
        print(f"[OK] Weather fetched from wttr.in: {min_c}C ~ {max_c}C")
        return {
            "source": "wttr.in",
            "desc": desc_en or "예보 수신 완료",
            "min_c": round(min_c, 1),
            "max_c": round(max_c, 1),
            "diurnal_range_c": round(max_c - min_c, 1),
            "rain_pct": rain_pct,
        }
    except Exception as e:
        print(f"[WARN] wttr.in failed: {e}")

    return {"source": "NONE", "desc": "조회 실패", "min_c": None, "max_c": None, "diurnal_range_c": None, "rain_pct": None}


def fetch_google_news_rss(query: str, limit: int = 8) -> list:
    url = f"https://news.google.com/rss/search?q={quote(query)}&hl=ko&gl=KR&ceid=KR:ko"
    try:
        r = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        root = ET.fromstring(r.content)
        items = []
        for item in root.findall(".//item")[:limit]:
            title = (item.findtext("title") or "").strip()
            pub_date = (item.findtext("pubDate") or "").strip()
            if title:
                items.append(f"- {title} ({pub_date[:16]})")
        return items
    except Exception as e:
        print(f"[WARN] RSS fetch failed for '{query}': {e}")
        return []


def fetch_github_commits_window(target_dt: datetime, cutoff_hour: int) -> dict:
    now_kst = datetime.now(KST)
    window_start = target_dt.replace(hour=cutoff_hour, minute=0, second=0, microsecond=0)
    spillover_end = target_dt.replace(hour=6, minute=0, second=0, microsecond=0)
    midnight_next = (target_dt + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    max_window_end = (target_dt + timedelta(days=1)).replace(hour=cutoff_hour, minute=59, second=59, microsecond=0)
    window_end = min(now_kst, max_window_end)
    if window_end < window_start:
        window_end = now_kst

    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    params = {
        "since": window_start.astimezone(timezone.utc).isoformat(),
        "until": window_end.astimezone(timezone.utc).isoformat(),
        "per_page": 50,
    }

    result = {
        "window_label": f"{window_start.strftime('%Y-%m-%d %H:%M')} ~ {window_end.strftime('%Y-%m-%d %H:%M')} KST",
        "spillover_prev": [],
        "main_day": [],
        "late_night": [],
        "total_count": 0,
    }

    try:
        r = requests.get(f"https://api.github.com/repos/{GITHUB_REPO}/commits", headers=headers, params=params, timeout=20)
        if r.status_code != 200:
            return result
        for item in r.json():
            msg = item.get("commit", {}).get("message", "").splitlines()[0]
            ts_raw = item.get("commit", {}).get("author", {}).get("date", "")
            if not ts_raw:
                continue
            dt_kst = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).astimezone(KST)
            entry = f"- [{dt_kst.strftime('%m/%d %H:%M')}] {msg}"
            if window_start <= dt_kst < spillover_end:
                result["spillover_prev"].append(entry)
            elif spillover_end <= dt_kst < midnight_next:
                result["main_day"].append(entry)
            else:
                result["late_night"].append(entry)
            result["total_count"] += 1
        return result
    except Exception as e:
        print(f"[WARN] github commits fetch failed: {e}")
        return result


def build_generation_config(model_name: str) -> types.GenerateContentConfig:
    kwargs = {"response_mime_type": "application/json"}
    if model_name.startswith("gemini-4-"):
        try:
            kwargs["thinking_config"] = types.ThinkingConfig(thinking_level="MEDIUM")
        except Exception:
            pass
    return types.GenerateContentConfig(**kwargs)


def call_gemini_json(prompt: str) -> tuple:
    client = genai.Client(api_key=GEMINI_API_KEY)
    candidates = []
    for m in [GEMINI_MODEL, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]:
        if m and m not in candidates:
            candidates.append(m)

    last_err = None
    for model_name in candidates:
        max_attempts = 2 if model_name != "gemini-3.5-flash-lite" else 1
        for attempt in range(1, max_attempts + 1):
            try:
                print(f"[INFO] Trying Gemini model: {model_name} (attempt {attempt}/{max_attempts})")
                resp = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=build_generation_config(model_name),
                )
                text = (resp.text or "").strip()
                cleaned = re.sub(r"^```(?:json)?\s*", "", text)
                cleaned = re.sub(r"\s*```$", "", cleaned)
                start = cleaned.find("{")
                end = cleaned.rfind("}")
                if start == -1 or end == -1:
                    raise ValueError(f"Invalid JSON from {model_name}:\n{text[:400]}")
                print(f"[OK] Gemini succeeded with model: {model_name}")
                return json.loads(cleaned[start : end + 1]), model_name
            except Exception as e:
                print(f"[WARN] Model {model_name} attempt {attempt} failed: {e}")
                last_err = e
                if attempt < max_attempts:
                    time.sleep(5)

    raise RuntimeError(f"All Gemini models failed. Last error: {last_err}")


def run_morning_brief():
    now_kst = datetime.now(KST)
    today_str = now_kst.strftime("%Y-%m-%d")
    weekday_ko = WEEKDAYS_KO[now_kst.weekday()]
    is_monday = now_kst.weekday() == 0
    dynamic_context = build_dynamic_context()

    macro_tickers = {
        "S&P 500": "^GSPC",
        "NASDAQ": "^IXIC",
        "DOW 30": "^DJI",
        "US 10Y": "^TNX",
        "VIX": "^VIX",
        "KOSPI": "^KS11",
        "KOSDAQ": "^KQ11",
        "USD/KRW": "KRW=X",
    }
    macro = {name: fetch_quote(sym) for name, sym in macro_tickers.items()}
    usdkrw = macro["USD/KRW"]["price"] or 1350.0

    holdings_rows = sb_select("portfolio_holdings", {"select": "*"})
    total_buy, total_eval = 0.0, 0.0
    us_buy, us_eval = 0.0, 0.0
    kr_buy, kr_eval = 0.0, 0.0
    holding_details = []

    for row in holdings_rows:
        q = fetch_quote(row["ticker"])
        qty = float(row["quantity"])
        buy_krw = float(row["total_buy_krw"])
        price = q["price"]
        if price is None:
            eval_krw = buy_krw
        elif row["currency"] == "USD":
            eval_krw = price * qty * usdkrw
        else:
            eval_krw = price * qty

        pnl_krw = eval_krw - buy_krw
        ret_pct = (pnl_krw / buy_krw * 100.0) if buy_krw > 0 else 0.0
        total_buy += buy_krw
        total_eval += eval_krw
        if row["account_type"] == "US":
            us_buy += buy_krw
            us_eval += eval_krw
        else:
            kr_buy += buy_krw
            kr_eval += eval_krw

        holding_details.append({
            "ticker": row["display_name"],
            "raw_ticker": row["ticker"],
            "account_type": row["account_type"],
            "currency": row["currency"],
            "quantity": qty,
            "close_price": price,
            "daily_change_pct": q["change_pct"],
            "quote_date": q["date"],
            "buy_krw": round(buy_krw),
            "eval_krw": round(eval_krw),
            "pnl_krw": round(pnl_krw),
            "eval_man": round(eval_krw / 10000),
            "return_pct": round(ret_pct, 2),
        })

    for h in holding_details:
        h["weight_pct"] = round((h["eval_krw"] / total_eval * 100.0), 1) if total_eval > 0 else 0.0

    holding_details.sort(key=lambda x: x["eval_krw"], reverse=True)
    total_pnl = total_eval - total_buy
    total_ret = (total_pnl / total_buy * 100.0) if total_buy else 0.0
    us_ret = ((us_eval - us_buy) / us_buy * 100.0) if us_buy else 0.0
    kr_ret = ((kr_eval - kr_buy) / kr_buy * 100.0) if kr_buy else 0.0

    prev_briefs = sb_select(
        "morning_briefings",
        {"select": "brief_date,portfolio_snapshot,exhibition_picks", "order": "brief_date.asc", "limit": 30},
    )
    history_map = {}
    last_exhibition = "[주간 서울·수도권 추천 전시 (매주 월요일 07:00 정기 갱신)]\n• 매주 월요일 오전 7시 정기 스케줄에 맞춰 업데이트됩니다."
    for b in prev_briefs:
        if b.get("exhibition_picks"):
            last_exhibition = b["exhibition_picks"]
        snap = b.get("portfolio_snapshot") or {}
        if snap.get("total_buy_krw") and snap.get("total_eval_krw"):
            mmdd = b["brief_date"][5:10]
            history_map[mmdd] = {
                "date": mmdd,
                "buy": round(float(snap["total_buy_krw"]) / 10000),
                "eval": round(float(snap["total_eval_krw"]) / 10000),
            }

    today_mmdd = today_str[5:10]
    history_map[today_mmdd] = {"date": today_mmdd, "buy": round(total_buy / 10000), "eval": round(total_eval / 10000)}
    history_list = list(history_map.values())[-14:]

    portfolio_snapshot = {
        "total_buy_krw": round(total_buy),
        "total_eval_krw": round(total_eval),
        "total_return_pct": round(total_ret, 2),
        "us_eval_krw": round(us_eval),
        "us_return_pct": round(us_ret, 2),
        "kr_eval_krw": round(kr_eval),
        "kr_return_pct": round(kr_ret, 2),
        "history": history_list,
        "holdings": [
            {"ticker": h["ticker"], "eval_man": h["eval_man"], "return_pct": h["return_pct"]}
            for h in holding_details
        ],
    }

    weather = fetch_pyeongtaek_weather()
    econ_news = fetch_google_news_rss("미국 증시 코스피 금리 환율 경제 when:1d", limit=8)
    tech_news = fetch_google_news_rss("AI 반도체 엔비디아 구글 빅테크 IT when:1d", limit=7)
    exhibition_news = fetch_google_news_rss("서울 수도권 미술관 전시회 추천 when:7d", limit=8) if is_monday else []

    exhibition_rule = (
        "오늘은 월요일이므로 아래 수집된 전시 뉴스 헤드라인을 참고해 이번 주 서울·수도권 볼만한 전시 3~4곳을 전시명·장소·관람 포인트 중심으로 정리하라:\n"
        + ("\n".join(exhibition_news) if exhibition_news else "(수집된 전시 뉴스 없음 — 기존 안내 문구 유지)")
        if is_monday
        else f"오늘은 월요일이 아니므로 exhibition_picks에는 아래 기존 텍스트를 그대로 유지하라:\n{last_exhibition}"
    )

    prompt = f"""
너는 개인 웹사이트 busychronicler7800.github.io(순수 모노크롬 아카이브 & 05. REPORT 관리자 허브)의 수석 애널리스트 겸 프로젝트 아키텍트다.
오늘 날짜는 {today_str} ({weekday_ko}) 오전 07:00 KST다.
단순 요약이 아니라, 전문가 수준의 깊이와 구체적인 수치 근거를 갖춘 고밀도 모닝 브리핑을 한국어로 작성하라. 제공된 데이터에 없는 수치나 가짜 뉴스는 절대 지어내지 마라.

{dynamic_context}

[확정 거시 지수 데이터 (Yahoo Finance)]
{json.dumps(macro, ensure_ascii=False, indent=2)}

[확정 포트폴리오 평가 현황 (키움증권 API 미연동 — Supabase 기준 수량 × 최신 종가·환율 자동 산출)]
- 총 매입원금: {round(total_buy):,}원 / 총 평가금액: {round(total_eval):,}원 / 평가손익: {round(total_pnl):+,}원 ({total_ret:+.2f}%)
- 해외 위탁종합: 평가 {round(us_eval):,}원 ({us_ret:+.2f}%)
- 국내 중개형 ISA: 평가 {round(kr_eval):,}원 ({kr_ret:+.2f}%)
{json.dumps(holding_details, ensure_ascii=False, indent=2)}

[지난 24시간 실시간 경제·증시 헤드라인 (Google News RSS)]
{chr(10).join(econ_news) if econ_news else "(수집된 경제 뉴스 없음)"}

[지난 24시간 실시간 AI·IT 헤드라인 (Google News RSS)]
{chr(10).join(tech_news) if tech_news else "(수집된 IT 뉴스 없음)"}

[경기도 평택시 오늘 날씨]
{json.dumps(weather, ensure_ascii=False)}

[출력 형식 및 분량 규칙]
1. 반드시 순수 JSON 객체 하나만 반환하라. 키는 정확히 5개:
   "headline", "dev_strategy", "market_summary", "news_weather", "exhibition_picks"
2. 마크다운 기호(**, ##)를 절대 쓰지 말고, 웹사이트 모노크롬 텍스트 스타일([소제목], • 불릿, - 하위 항목, → 해석)을 사용하라.
3. headline: "{today_str} ({weekday_ko}) 07:00 모닝 브리핑 — 핵심 시장·프로젝트 테마 한 줄 요약"
4. dev_strategy (최소 12~16줄, 구체적 기술 실행안 중심):
   - [A. 현재 운영 인프라 및 예정 실행 계획·준비사항]: 위 실시간 로드맵(report_config)에 적힌 다음 예정 작업과 사전 준비 체크리스트 정리.
   - [B. 궁극적 목표 로드맵 (단일 리포트 → 웹 게시 → 아이폰/아이패드 푸시)]: 동일한 리포트 1본을 웹사이트에 고가독성으로 게시하고 iOS/iPadOS(홈 화면 PWA 웹 푸시 vs Discord/ntfy 등)로 즉시 알림 받아 열람하는 구체적 아키텍처 및 UI 가독성 개선 아이디어 제시.
5. market_summary (가장 상세하게 작성, 최소 18~25줄):
   - [1. 한·미 주요 지수 및 거시 환경]: 8개 확정 지표(S&P500, 나스닥, 다우, 미 국채 10년물, VIX, 코스피, 코스닥, 원/달러)를 빠짐없이 수치·등락률·기준일과 함께 정리하고, 수집된 뉴스 헤드라인과 연결한 시장 배경 코멘트 2~3문장 작성.
   - [2. 보유 6종목별 정밀 분석]: 해외 위탁(GOOGL, QLD, JEPQ)과 국내 ISA(TIME 나스닥100, KODEX S&P500, KODEX 배당커버드콜) 6종목 모두 각각에 대해 보유 주수, 비중(%), 최신 종가(일간 등락률), 평가금액(평가손익·누적 수익률)을 적고, 바로 아래 `→` 기호로 해당 종목의 성격에 맞는 구체적 흐름 분석을 1~2문장씩 작성.
   - [3. 포트폴리오 리스크 및 운용 체크포인트]: 현재 레버리지·기술주 집중도와 환율·변동성(VIX)을 근거로 오늘 장 대응 원칙 2~3가지 제시.
6. news_weather (최소 8~10줄):
   - [지난 24시간 주요 경제·IT 뉴스]: 위 RSS 헤드라인 중 영향력이 큰 4건을 선정해 사건 요약과 시장·기술 시사점을 각각 2줄 이상 정리.
   - [경기도 평택시 오늘의 날씨 예보 ({today_str} {weekday_ko})]: 위 날씨 JSON 수치를 반영해 최저·최고 기온, 일교차, 강수확률, 날씨 상태 및 옷차림 한 줄 팁.
7. exhibition_picks: {exhibition_rule}
"""

    result, used_model = call_gemini_json(prompt)

    sb_upsert(
        "morning_briefings",
        "brief_date",
        {
            "brief_date": today_str,
            "headline": result.get("headline", f"{today_str} ({weekday_ko}) 07:00 모닝 브리핑"),
            "dev_strategy": result.get("dev_strategy", ""),
            "market_summary": result.get("market_summary", ""),
            "news_weather": result.get("news_weather", ""),
            "exhibition_picks": result.get("exhibition_picks", last_exhibition),
            "portfolio_snapshot": portfolio_snapshot,
            "generated_model": used_model,
        },
    )
    print(f"[OK] morning_briefings upserted for {today_str} (model={used_model})")


def run_daily_review():
    now_kst = datetime.now(KST)
    target_dt = now_kst - timedelta(days=1)
    prev_dt = target_dt - timedelta(days=1)
    target_str = target_dt.strftime("%Y-%m-%d")
    prev_str = prev_dt.strftime("%Y-%m-%d")
    weekday_ko = WEEKDAYS_KO[target_dt.weekday()]
    dynamic_context = build_dynamic_context()

    commit_data = fetch_github_commits_window(target_dt, cutoff_hour=2)
    recent_reviews = sb_select("daily_reviews", {"select": "review_date,headline,next_priorities", "order": "review_date.desc", "limit": 2})

    spillover_block = ""
    if commit_data["spillover_prev"]:
        spillover_block = (
            f"직전 날({prev_str}) 분석 리포트 마감(02:00)을 넘겨 새벽에 이어진 커밋이 {len(commit_data['spillover_prev'])}건 감지되었다.\n"
            f"따라서 achievements 맨 아래에 별도 항목으로 반드시 다음 문구를 그대로 포함해 추가 첨부하라:\n"
            f"\"※ 이 날은 늦게까지 작업하여 다음 날 리포트에 반영했습니다. 실제 작업은 {prev_str}에서 {target_str}로 넘어가는 새벽에 작업한 내용들입니다.\"\n"
            + "\n".join(commit_data["spillover_prev"])
        )
    else:
        spillover_block = "(직전 날 리포트 발행 시각 이후 새벽 연장 커밋 없음)"

    prompt = f"""
너는 busychronicler7800 개인 프로젝트의 일일 작업 분석가다.
기준 날짜(작업 대상일)는 반드시 어제인 {target_str} ({weekday_ko})이다.
수집 구간은 자정(00:00)이 아닌 직전 리포트 마감 이후부터 리포트 작성 직전까지({commit_data['window_label']})이다.

{dynamic_context}

[1. {target_str} 주간·야간 커밋 (06:00~23:59 KST)]
{chr(10).join(commit_data['main_day']) if commit_data['main_day'] else "(해당 구간 커밋 없음)"}

[2. {target_str} 심야 연장 커밋 (자정 이후 ~ 리포트 작성 직전, 모두 {target_str} 작업분에 포함)]
{chr(10).join(commit_data['late_night']) if commit_data['late_night'] else "(심야 연장 커밋 없음)"}

[3. 직전 날({prev_str}→{target_str}) 새벽 이월 커밋 처리 규칙]
{spillover_block}

[직전 분석 리포트 맥락]
{json.dumps(recent_reviews, ensure_ascii=False, indent=2)}

[작성 규칙]
1. 반드시 순수 JSON 객체 하나만 반환하라. 키는 정확히 4개:
   "headline", "achievements", "insights", "next_priorities"
2. 마크다운 기호(**, ##)를 쓰지 말고 • 불릿과 번호(1., 2.)를 사용한 고밀도 한국어 평문으로 작성하라.
3. headline은 "{target_str} ({weekday_ko}) 작업 분석 리포트: 핵심 성과 한 줄 요약" 형식으로 작성하라.
4. 커밋 총 건수가 0건이면 작업을 지어내지 말고, 휴무·점검일 기준으로 시스템 안정성과 다음 단계 준비사항 중심으로 작성하라.
5. 심야 연장 커밋(섹션 2)이 있으면 자정 넘긴 새벽 작업까지 {target_str} 성과에 빠짐없이 통합 기록하라.
6. 직전 날 새벽 이월 커밋(섹션 3)이 있으면 지정된 안내 문구와 함께 별도 항목으로 반드시 첨부하라.
7. next_priorities에는 위 실시간 로드맵(report_config)의 다음 예정 작업, 사전 준비 체크리스트, 그리고 궁극적 목표 실행 단계를 구체적으로 반영하라.
"""

    result, used_model = call_gemini_json(prompt)
    sb_upsert(
        "daily_reviews",
        "review_date",
        {
            "review_date": target_str,
            "headline": result.get("headline", f"{target_str} ({weekday_ko}) 작업 분석 리포트"),
            "achievements": result.get("achievements", ""),
            "insights": result.get("insights", ""),
            "next_priorities": result.get("next_priorities", ""),
            "generated_model": used_model,
        },
    )
    print(f"[OK] daily_reviews upserted for {target_str} (model={used_model})")


def run_work_log():
    now_kst = datetime.now(KST)
    target_dt = now_kst - timedelta(days=1)
    prev_dt = target_dt - timedelta(days=1)
    target_str = target_dt.strftime("%Y-%m-%d")
    prev_str = prev_dt.strftime("%Y-%m-%d")
    weekday_ko = WEEKDAYS_KO[target_dt.weekday()]
    dynamic_context = build_dynamic_context()

    commit_data = fetch_github_commits_window(target_dt, cutoff_hour=3)
    status_type = "ACTIVE" if commit_data["total_count"] > 0 else "REST"
    recent_logs = sb_select("work_logs", {"select": "log_date,title,active_pipelines", "order": "log_date.desc", "limit": 2})
    latest_brief = sb_select("morning_briefings", {"select": "brief_date,portfolio_snapshot", "order": "brief_date.desc", "limit": 1})

    spillover_block = ""
    if commit_data["spillover_prev"]:
        spillover_block = (
            f"직전 날({prev_str}) 작업 일지 마감(03:00)을 넘겨 새벽에 이어진 커밋이 {len(commit_data['spillover_prev'])}건 감지되었다.\n"
            f"따라서 completed_summary 맨 아래에 별도 항목으로 반드시 다음 문구를 그대로 포함해 추가 첨부하라:\n"
            f"\"※ 이 날은 늦게까지 작업하여 다음 날 작업 일지에 반영했습니다. 실제 작업은 {prev_str}에서 {target_str}로 넘어가는 새벽에 작업한 내용들입니다.\"\n"
            + "\n".join(commit_data["spillover_prev"])
        )
    else:
        spillover_block = "(직전 날 작업 일지 발행 시각 이후 새벽 연장 커밋 없음)"

    prompt = f"""
너는 busychronicler7800의 일일 작업 일지 기록관이다.
기준 날짜(작업 대상일)는 반드시 어제인 {target_str} ({weekday_ko})이다.
상태 타입은 "{status_type}"이며, 커밋 수집 구간은 {commit_data['window_label']}이다.

{dynamic_context}

[1. {target_str} 주간·야간 커밋 (06:00~23:59 KST)]
{chr(10).join(commit_data['main_day']) if commit_data['main_day'] else "(해당 구간 커밋 없음)"}

[2. {target_str} 심야 연장 커밋 (자정 이후 ~ 작업 일지 작성 직전, 모두 {target_str} 작업분에 포함)]
{chr(10).join(commit_data['late_night']) if commit_data['late_night'] else "(심야 연장 커밋 없음)"}

[3. 직전 날({prev_str}→{target_str}) 새벽 이월 커밋 처리 규칙]
{spillover_block}

[직전 작업 일지]
{json.dumps(recent_logs, ensure_ascii=False, indent=2)}

[최근 포트폴리오 스냅샷]
{json.dumps(latest_brief, ensure_ascii=False, indent=2)}

[작성 규칙]
1. 반드시 순수 JSON 객체 하나만 반환하라. 키는 정확히 5개:
   "title", "tools", "completed_summary", "active_pipelines", "problem_analysis"
2. 마크다운 기호(**, ##)를 쓰지 말고 • 불릿과 번호(1., 2.)로 정리하라.
3. title은 1줄 핵심 제목(날짜 제외), tools는 문자열 배열(예: ["GitHub Actions", "Supabase", "Gemini API"])로 반환하라.
4. completed_summary는 "• {target_str} ({weekday_ko}) 완료 작업 요약"으로 시작하고, 심야 연장 커밋까지 빠짐없이 포함하라. 커밋이 0건이면 휴무일 점검 내용으로 솔직하게 작성하라. 직전 날 새벽 이월 커밋이 있으면 지정 문구와 함께 반드시 별도 첨부하라.
5. active_pipelines는 가동 중인 파이프라인(busychronicler7800.github.io, Supabase, cron-job.org + GitHub Actions 자동 리포트, 항공권 트래커)과 최근 포트폴리오 평가 현황을 정리하라.
6. problem_analysis는 문제점 진단·해결책, 물리치료학 전공/개발 학습 포인트, 그리고 위 로드맵의 궁극적 목표 및 다음 단계 준비 포인트를 기록하라.
"""

    result, used_model = call_gemini_json(prompt)
    tools = result.get("tools", ["GitHub Actions", "Supabase", "Gemini API"])
    if not isinstance(tools, list):
        tools = ["GitHub Actions", "Supabase"]

    sb_upsert(
        "work_logs",
        "log_date",
        {
            "log_date": target_str,
            "title": result.get("title", f"{target_str} 작업 일지"),
            "status_type": status_type,
            "tools": [str(t) for t in tools],
            "completed_summary": result.get("completed_summary", ""),
            "active_pipelines": result.get("active_pipelines", ""),
            "problem_analysis": result.get("problem_analysis", ""),
            "generated_model": used_model,
        },
    )
    print(f"[OK] work_logs upserted for {target_str} (model={used_model})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=["morning", "review", "worklog"])
    args = parser.parse_args()

    if args.mode == "morning":
        run_morning_brief()
    elif args.mode == "review":
        run_daily_review()
    elif args.mode == "worklog":
        run_work_log()
