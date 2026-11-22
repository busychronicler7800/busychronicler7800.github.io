import os
import json
from datetime import datetime, timezone, timedelta
import requests
import matplotlib

# 화면이 없는 서버(GitHub Actions)에서도 차트 이미지를 생성하기 위한 설정
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# =====================================================================
# [사용자 설정 영역]
# GitHub Actions에서는 Secrets 값을 자동으로 불러오며,
# 내 PC에서 직접 실행할 때는 아래 따옴표("") 안의 값을 사용합니다.
# =====================================================================
SERPAPI_KEY = os.getenv("SERPAPI_KEY") or "9233ecb07f50f47b5522a7c9c0ba6e27b19021cf91cf77284afd318cc375a52f"
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL") or "https://discord.com/api/webhooks/1573958568116224060/50sVkchuHwz9u5AgKW5CM3PcP_oSBJNrGjopk5b9GhN4YM2m27YqYxKQyV-Zyh63LUpc"

# 목표 가격 (단위: 원)
TARGET_PRICE_KRW = 2000000

# True로 바꾸면 가격이 떨어졌을 때만 알림 발송 / False면 실행할 때마다 리포트+차트 발송
NOTIFY_ONLY_ON_DROP = False

# 희망 비행 일정
MULTI_CITY_LEGS = [
    {
        "departure_id": "ICN",
        "arrival_id": "PVG",
        "date": "2027-07-26",       # 1일차: 인천 → 상하이
        "times": "6,11,7,13",       # 오전 6~11시 출발, 7~13시 도착
    },
    {
        "departure_id": "PVG",
        "arrival_id": "IST",
        "date": "2027-07-28",       # 3일차 밤: 상하이 → 이스탄불
        "times": "20,23,4,9",       # 밤 20~23시 출발, 다음날 새벽 4~9시 도착
    },
    {
        "departure_id": "IST",
        "arrival_id": "ICN",
        "date": "2027-08-01",       # 귀국일: 이스탄불 → 인천
    },
]
# =====================================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HISTORY_FILE = os.path.join(BASE_DIR, "price_history.json")
CHART_FILE = os.path.join(BASE_DIR, "price_trend.png")
KST = timezone(timedelta(hours=9))


def fetch_multicity_lowest():
    if not SERPAPI_KEY or "여기에_" in SERPAPI_KEY:
        raise ValueError("SERPAPI_KEY가 설정되지 않았습니다.")
    if not DISCORD_WEBHOOK_URL or "여기에_" in DISCORD_WEBHOOK_URL:
        raise ValueError("DISCORD_WEBHOOK_URL이 설정되지 않았습니다.")

    params = {
        "engine": "google_flights",
        "type": "3",          # 3 = 다구간(Multi-city)
        "stops": "1",         # 1 = 직항 전용(Nonstop only)
        "currency": "KRW",
        "hl": "ko",
        "gl": "kr",
        "multi_city_json": json.dumps(MULTI_CITY_LEGS),
        "api_key": SERPAPI_KEY,
    }

    res = requests.get("https://serpapi.com/search.json", params=params, timeout=30)
    res.raise_for_status()
    data = res.json()

    flights = data.get("best_flights", []) + data.get("other_flights", [])
    if not flights:
        return None, None, ""

    cheapest = min(flights, key=lambda x: x.get("price", float("inf")))
    price = cheapest.get("price")
    google_url = data.get("search_metadata", {}).get("google_flights_url", "")

    airlines = []
    for seg in cheapest.get("flights", []):
        name = seg.get("airline")
        if name and name not in airlines:
            airlines.append(name)
    airline_str = " + ".join(airlines) if airlines else "직항 조합"

    return price, google_url, airline_str


def load_history():
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("records", [])
    return []


def save_history(records):
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump({"records": records}, f, ensure_ascii=False, indent=2)


def analyze_stats(records, current_price):
    """누적 데이터 대비 현재 가격의 저렴한 순위(상위 %) 및 통계 계산"""
    prices = [r["price"] for r in records]
    total = len(prices)
    min_price = min(prices)
    max_price = max(prices)
    avg_price = round(sum(prices) / total)

    # 현재 가격보다 더 저렴했던 기록의 수 + 1 = 저렴한 순위 (1위가 최저가)
    cheaper_count = sum(1 for p in prices if p < current_price)
    rank = cheaper_count + 1
    top_percent = round((rank / total) * 100, 1)

    return {
        "total": total,
        "min_price": min_price,
        "max_price": max_price,
        "avg_price": avg_price,
        "rank": rank,
        "top_percent": top_percent,
    }


def generate_trend_chart(records, stats):
    """누적 가격 추이를 PNG 차트로 저장 (폰트 깨짐 방지를 위해 영문/숫자 라벨 사용)"""
    timestamps = [r["timestamp"][5:] for r in records]  # "MM-DD HH:MM" 형태
    prices_manwon = [r["price"] / 10000 for r in records]  # 만원 단위 변환

    fig, ax = plt.subplots(figsize=(9, 4.5), dpi=150)
    x = list(range(len(records)))

    # 가격 추이 선 및 영역 채우기
    ax.plot(x, prices_manwon, color="#2563EB", linewidth=2.2, marker="o", markersize=6, label="Recorded Price")
    ax.fill_between(x, prices_manwon, min(prices_manwon) * 0.97, color="#3B82F6", alpha=0.12)

    # 목표가 및 평균가 기준선
    target_manwon = TARGET_PRICE_KRW / 10000
    avg_manwon = stats["avg_price"] / 10000
    ax.axhline(target_manwon, color="#16A34A", linestyle="--", linewidth=1.4, label=f"Target ({target_manwon:,.0f}0k)")
    if len(records) > 1:
        ax.axhline(avg_manwon, color="#F59E0B", linestyle=":", linewidth=1.4, label=f"Average ({avg_manwon:,.1f}0k)")

    # 최신 가격 강조 표시 및 수치 라벨
    latest_x = x[-1]
    latest_y = prices_manwon[-1]
    ax.scatter([latest_x], [latest_y], color="#DC2626", s=85, zorder=5, label=f"Current ({latest_y:,.1f}0k)")
    ax.annotate(
        f"{latest_y:,.1f}만",
        xy=(latest_x, latest_y),
        xytext=(0, 10),
        textcoords="offset points",
        ha="center",
        fontsize=9,
        fontweight="bold",
        color="#DC2626",
    )

    # X축 눈금 간격 자동 조절 (데이터가 많아져도 글자가 겹치지 않게 처리)
    step = max(1, len(x) // 8)
    tick_indices = list(range(0, len(x), step))
    if tick_indices[-1] != x[-1]:
        tick_indices.append(x[-1])
    ax.set_xticks(tick_indices)
    ax.set_xticklabels([timestamps[i] for i in tick_indices], rotation=25, ha="right", fontsize=8.5)

    # Y축 여백 및 포맷
    y_min = min(min(prices_manwon), target_manwon) * 0.96
    y_max = max(max(prices_manwon), target_manwon) * 1.04
    ax.set_ylim(y_min, y_max)
    ax.set_ylabel("Price (10,000 KRW)", fontsize=9.5)
    ax.set_title(
        f"ICN - PVG - IST - ICN Price Trend (Top {stats['top_percent']}% | {stats['total']} Checks)",
        fontsize=11,
        fontweight="bold",
        pad=12,
    )

    ax.grid(True, linestyle="--", alpha=0.35)
    ax.legend(loc="upper left", fontsize=8.5, frameon=True)
    plt.tight_layout()
    plt.savefig(CHART_FILE)
    plt.close(fig)


def send_discord_report(price, url, airline_str, stats, status_badge):
    diff_avg = price - stats["avg_price"]
    diff_sign = "+" if diff_avg > 0 else ""

    message = (
        f"✈️ **상하이·이스탄불 직항 다구간 가격 리포트** `{status_badge}`\n"
        f"- **현재 최저가:** **`{price:,}원`** ({airline_str})\n"
        f"- **가격 위치:** 역대 조회 데이터 중 저렴한 순 **상위 {stats['top_percent']}%** ({stats['rank']}위 / 총 {stats['total']}회)\n"
        f"- **누적 통계:** 최저 `{stats['min_price']:,}원` · 평균 `{stats['avg_price']:,}원` (`{diff_sign}{diff_avg:,}원`) · 최고 `{stats['max_price']:,}원`\n"
        f"- **일정:** `{MULTI_CITY_LEGS[0]['date']}` ICN→PVG / `{MULTI_CITY_LEGS[1]['date']}` PVG→IST / `{MULTI_CITY_LEGS[2]['date']}` IST→ICN\n"
        f"- **구글 플라이트 확인:** {url}"
    )

    with open(CHART_FILE, "rb") as img_file:
        files = {
            "payload_json": (None, json.dumps({"content": message}), "application/json"),
            "file": ("price_trend.png", img_file, "image/png"),
        }
        res = requests.post(DISCORD_WEBHOOK_URL, files=files, timeout=20)
        res.raise_for_status()


def main():
    price, google_url, airline_str = fetch_multicity_lowest()
    if price is None:
        print("조건에 맞는 직항 조합을 찾지 못했습니다.")
        return

    records = load_history()
    prev_min = min((r["price"] for r in records), default=float("inf"))

    now_kst = datetime.now(KST).strftime("%Y-%m-%d %H:%M")
    records.append({
        "timestamp": now_kst,
        "price": price,
        "airlines": airline_str,
    })
    save_history(records)

    stats = analyze_stats(records, price)
    generate_trend_chart(records, stats)

    is_new_low = price < prev_min
    is_target_hit = price <= TARGET_PRICE_KRW

    if is_target_hit and is_new_low:
        badge = "🎯 목표가 도달 & 역대 최저가!"
    elif is_new_low:
        badge = "🔥 역대 최저가 갱신"
    elif is_target_hit:
        badge = "🎯 목표가 이하"
    else:
        badge = "📊 정기 가격 체크"

    print(f"[{now_kst}] {price:,}원 | 상위 {stats['top_percent']}% ({stats['rank']}/{stats['total']}위) | {badge}")

    if not NOTIFY_ONLY_ON_DROP or is_new_low or is_target_hit:
        send_discord_report(price, google_url, airline_str, stats, badge)
        print("✅ 디스코드로 리포트와 가격 추이 차트를 전송했습니다.")
    else:
        print("가격 하락이 없어 알림을 생략했습니다.")


if __name__ == "__main__":
    main()