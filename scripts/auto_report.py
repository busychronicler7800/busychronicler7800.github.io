import argparse
import json
import os
import re
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
    url = (
        "https://api.open-meteo.com/v1/forecast"
        "?latitude=36.9921&longitude=127.1129"
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
        "&timezone=Asia%2FSeoul&forecast_days=1"
    )
    try:
        data = requests.get(url, timeout=15).json().get("daily", {})
        code = int(data.get("weather_code", [0])[0])
        return {
            "desc": WMO_WEATHER_KO.get(code, f"날씨코드 {code}"),
            "min_c": data.get("temperature_2m_min", [None])[0],
            "max_c": data.get("temperature_2m_max", [None])[0],
            "rain_pct": data.get("precipitation_probability_max", [None])[0],
        }
    except Exception as e:
        print(f"[WARN] weather fetch failed: {e}")
        return {"desc": "조회 실패", "min_c": None, "max_c": None, "rain_pct": None}


def fetch_google_news_rss(query: str, limit: int = 6) -> list:
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


def fetch_github_commits(target_date_str: str) -> list:
    start_kst = datetime.strptime(target_date_str, "%Y-%m-%d").replace(tzinfo=KST)
    end_kst = start_kst + timedelta(days=1)
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    params = {
        "since": start_kst.astimezone(timezone.utc).isoformat(),
        "until": end_kst.astimezone(timezone.utc).isoformat(),
        "per_page": 50,
    }
    try:
        r = requests.get(f"https://api.github.com/repos/{GITHUB_REPO}/commits", headers=headers, params=params, timeout=20)
        if r.status_code != 200:
            return []
        commits = []
        for item in r.json():
            msg = item.get("commit", {}).get("message", "").splitlines()[0]
            ts = item.get("commit", {}).get("author", {}).get("date", "")
            commits.append(f"- {msg} ({ts[:16]})")
        return commits
    except Exception as e:
        print(f"[WARN] github commits fetch failed: {e}")
        return []


def call_gemini_json(prompt: str) -> dict:
    client = genai.Client(api_key=GEMINI_API_KEY)
    candidates = []
    for m in [GEMINI_MODEL, "gemini-3.8-flash", "gemini-3.5-flash-lite"]:
        if m and m not in candidates:
            candidates.append(m)

    last_err = None
    for model_name in candidates:
        try:
            print(f"[INFO] Trying Gemini model: {model_name}")
            resp = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                ),
            )
            text = (resp.text or "").strip()
            cleaned = re.sub(r"^```(?:json)?\s*", "", text)
            cleaned = re.sub(r"\s*```$", "", cleaned)
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start == -1 or end == -1:
                raise ValueError(f"Invalid JSON from {model_name}:\n{text[:400]}")
            print(f"[OK] Gemini succeeded with model: {model_name}")
            return json.loads(cleaned[start : end + 1])
        except Exception as e:
            print(f"[WARN] Model {model_name} failed: {e}")
            last_err = e

    raise RuntimeError(f"All Gemini models failed. Last error: {last_err}")


def run_morning_brief():
    now_kst = datetime.now(KST)
    today_str = now_kst.strftime("%Y-%m-%d")
    weekday_ko = WEEKDAYS_KO[now_kst.weekday()]
    is_monday = now_kst.weekday() == 0

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

        ret_pct = ((eval_krw - buy_krw) / buy_krw * 100.0) if buy_krw > 0 else 0.0
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
            "eval_man": round(eval_krw / 10000),
            "return_pct": round(ret_pct, 2),
        })

    holding_details.sort(key=lambda x: x["eval_krw"], reverse=True)
    total_ret = ((total_eval - total_buy) / total_buy * 100.0) if total_buy else 0.0
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
    econ_news = fetch_google_news_rss("미국 증시 코스피 금리 환율 when:1d", limit=6)
    tech_news = fetch_google_news_rss("AI 반도체 엔비디아 구글 IT when:1d", limit=5)
    exhibition_news = fetch_google_news_rss("서울 수도권 미술관 전시회 추천 when:7d", limit=6) if is_monday else []

    exhibition_rule = (
        "오늘은 월요일이므로 아래 수집된 전시 뉴스 헤드라인을 참고해 이번 주 서울·수도권 볼만한 전시 3~4곳을 정리하라:\n"
        + ("\n".join(exhibition_news) if exhibition_news else "(수집된 전시 뉴스 없음 — 기존 안내 문구 유지)")
        if is_monday
        else f"오늘은 월요일이 아니므로 exhibition_picks에는 아래 기존 텍스트를 그대로 유지하라:\n{last_exhibition}"
    )

    prompt = f"""
너는 개인 웹사이트 busychronicler7800.github.io(모노크롬 아카이브 & 05. REPORT 관리자 허브)의 수석 비서다.
오늘 날짜는 {today_str} ({weekday_ko}) 오전 07:00 KST다.
아래 확정 수집 데이터를 바탕으로, 한국어로 밀도 높은 종합 모닝 브리핑을 작성하라. 없는 수치나 뉴스를 임의로 지어내지 마라.

[확정 거시 지수 데이터 (Yahoo Finance)]
{json.dumps(macro, ensure_ascii=False, indent=2)}

[확정 보유 종목 시세 및 평가 현황 (키움증권 API 미연동 — Supabase 기준 수량 × 최신 종가·환율 자동 산출)]
- 총 매입원금: {round(total_buy):,}원 / 총 평가금액: {round(total_eval):,}원 ({total_ret:+.2f}%)
- 해외 위탁종합: 평가 {round(us_eval):,}원 ({us_ret:+.2f}%)
- 국내 중개형 ISA: 평가 {round(kr_eval):,}원 ({kr_ret:+.2f}%)
{json.dumps(holding_details, ensure_ascii=False, indent=2)}

[지난 24시간 실시간 경제·증시 헤드라인 (Google News RSS)]
{chr(10).join(econ_news) if econ_news else "(수집된 경제 뉴스 없음)"}

[지난 24시간 실시간 AI·IT 헤드라인 (Google News RSS)]
{chr(10).join(tech_news) if tech_news else "(수집된 IT 뉴스 없음)"}

[경기도 평택시 오늘 날씨 (Open-Meteo)]
{json.dumps(weather, ensure_ascii=False)}

[작성 규칙]
1. 반드시 순수 JSON 객체 하나만 반환하라. 키는 정확히 다음 5개다:
   "headline", "dev_strategy", "market_summary", "news_weather", "exhibition_picks"
2. 마크다운 기호(**, ##) 대신 웹사이트 모노크롬 텍스트 박스 스타일([소제목], • 불릿, - 하위 항목)을 사용하라.
3. headline 형식: "{today_str} ({weekday_ko}) 07:00 모닝 브리핑 — 핵심 테마 한 줄 요약"
4. dev_strategy: busychronicler7800.github.io(커스텀 도메인 미보유) 운영 점검, 모듈화(index.html/styles.css/js/*) 유지, 키움증권 연동 대기 상태 및 다음 2단계-B2(키움 REST API·해외 체결 메일 파싱)/3단계(구글 타임라인 지도) 실행 아이디어를 [A.], [B.] 구조로 작성하라.
5. market_summary:
   - [1. 한·미 주요 지수 및 거시 흐름]: 위 확정 지수 8종(S&P500, 나스닥, 다우, 미 국채 10년물, VIX, 코스피, 코스닥, 원/달러)을 빠짐없이 수치·등락률과 함께 정리하고 헤드라인 기반 시장 배경 코멘트를 작성하라.
   - [2. 보유 6종목별 현황 및 분석]: 해외 위탁(GOOGL, QLD, JEPQ)과 국내 ISA(TIME 나스닥100, KODEX S&P500, KODEX 배당커버드콜) 6종목 모두의 주수, 최신 종가·일간 등락률, 평가금액, 누적 수익률, 종목별 핵심 코멘트를 빠짐없이 작성하라.
   - [3. 운용 전략]: 현재 변동성과 비중을 고려한 현실적 체크포인트를 제시하라.
6. news_weather:
   - [지난 24시간 주요 경제·IT 뉴스]: 위 실시간 RSS 헤드라인 중 핵심 3~4건을 묶어 요약.
   - [경기도 평택시 오늘의 날씨 예보 ({today_str} {weekday_ko})]: 위 Open-Meteo 수치를 반영해 기온·일교차·강수확률·날씨 정리.
7. exhibition_picks: {exhibition_rule}
"""

    result = call_gemini_json(prompt)

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
        },
    )
    print(f"[OK] morning_briefings upserted for {today_str}")


def run_daily_review():
    target_dt = datetime.now(KST) - timedelta(days=1)
    target_str = target_dt.strftime("%Y-%m-%d")
    weekday_ko = WEEKDAYS_KO[target_dt.weekday()]

    commits = fetch_github_commits(target_str)
    recent_reviews = sb_select("daily_reviews", {"select": "review_date,headline,next_priorities", "order": "review_date.desc", "limit": 2})

    prompt = f"""
너는 busychronicler7800 개인 프로젝트의 일일 작업 분석가다.
기준 날짜(작업 대상일)는 반드시 어제인 {target_str} ({weekday_ko})이다.

[{target_str} GitHub 저장소 커밋 이력]
{chr(10).join(commits) if commits else "(커밋 없음 — 비작업일 또는 오프라인 학습/점검일)"}

[직전 분석 리포트 맥락]
{json.dumps(recent_reviews, ensure_ascii=False, indent=2)}

[작성 규칙]
1. 반드시 순수 JSON 객체 하나만 반환하라. 키는 정확히 다음 4개다:
   "headline", "achievements", "insights", "next_priorities"
2. headline은 "{target_str} ({weekday_ko}) 작업 분석 리포트: 핵심 한 줄 요약" 형식으로 작성하라.
3. 커밋이 없으면 억지로 작업을 지어내지 말고, 휴무·점검일 기준으로 시스템 안정성과 다음 단계 준비사항 중심으로 솔직하게 작성하라.
4. 각 필드는 불릿(•) 또는 번호(1., 2.)를 사용한 한국어 평문으로 작성하라.
"""

    result = call_gemini_json(prompt)
    sb_upsert(
        "daily_reviews",
        "review_date",
        {
            "review_date": target_str,
            "headline": result.get("headline", f"{target_str} ({weekday_ko}) 작업 분석 리포트"),
            "achievements": result.get("achievements", ""),
            "insights": result.get("insights", ""),
            "next_priorities": result.get("next_priorities", ""),
        },
    )
    print(f"[OK] daily_reviews upserted for {target_str}")


def run_work_log():
    target_dt = datetime.now(KST) - timedelta(days=1)
    target_str = target_dt.strftime("%Y-%m-%d")
    weekday_ko = WEEKDAYS_KO[target_dt.weekday()]

    commits = fetch_github_commits(target_str)
    status_type = "ACTIVE" if commits else "REST"
    recent_logs = sb_select("work_logs", {"select": "log_date,title,active_pipelines", "order": "log_date.desc", "limit": 2})
    latest_brief = sb_select("morning_briefings", {"select": "brief_date,portfolio_snapshot", "order": "brief_date.desc", "limit": 1})

    prompt = f"""
너는 busychronicler7800의 일일 작업 일지 기록관이다.
기준 날짜(작업 대상일)는 반드시 어제인 {target_str} ({weekday_ko})이다.
상태 타입은 "{status_type}"이다.

[{target_str} GitHub 커밋 이력]
{chr(10).join(commits) if commits else "(커밋 없음 — REST 비작업일/점검일)"}

[직전 작업 일지]
{json.dumps(recent_logs, ensure_ascii=False, indent=2)}

[최근 포트폴리오 스냅샷]
{json.dumps(latest_brief, ensure_ascii=False, indent=2)}

[작성 규칙]
1. 반드시 순수 JSON 객체 하나만 반환하라. 키는 정확히 다음 5개다:
   "title", "tools", "completed_summary", "active_pipelines", "problem_analysis"
2. title은 1줄 핵심 제목(날짜 제외), tools는 문자열 배열(예: ["GitHub Actions", "Supabase", "Gemini API"])로 반환하라.
3. completed_summary는 "{target_str} ({weekday_ko}) 완료 작업 요약"으로 시작하되 커밋이 없으면 휴무일 점검 내용으로 솔직하게 작성하라.
4. active_pipelines는 현재 가동 중인 파이프라인(busychronicler7800.github.io, Supabase, GitHub Actions 자동 리포트, 항공권 트래커)과 포트폴리오 최근 평가 현황(키움증권 미연동 표기 포함)을 정리하라.
5. problem_analysis는 문제점 진단·해결책 및 물리치료학 전공/개발 학습 포인트를 기록하라.
"""

    result = call_gemini_json(prompt)
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
        },
    )
    print(f"[OK] work_logs upserted for {target_str}")


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
