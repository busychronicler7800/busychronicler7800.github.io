// =========================================================
// 05. REPORT HUB — DB READ SYNC + MORNING BRIEF / REVIEW / WORK LOG
// =========================================================
let cachedDailyReviews = [];
let cachedWorkLogs = [];
let cachedMorningBriefs = [];
let openDailyReviewIds = new Set();
let openWorkLogIds = new Set();
let chartInstances = {};

// =========================================================
// ACCOUNT-LEVEL UNREAD TRACKING (SUPABASE DB + YYYY-MM-DD KEY)
// =========================================================
function getReadSet(profileColumn) {
  if (!currentUserProfile || !Array.isArray(currentUserProfile[profileColumn])) {
    return new Set();
  }
  const normalized = currentUserProfile[profileColumn]
    .map(k => String(k || "").slice(0, 10))
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
  return new Set(normalized);
}

async function refreshReadStateFromDB() {
  if (!currentUser) return;
  const { data, error } = await sb
    .from("user_profiles")
    .select("read_daily_reviews, read_work_logs")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error) {
    console.error("Read status fetch error:", error.message);
    return;
  }

  if (data && currentUserProfile) {
    currentUserProfile.read_daily_reviews = Array.isArray(data.read_daily_reviews) ? data.read_daily_reviews : [];
    currentUserProfile.read_work_logs = Array.isArray(data.read_work_logs) ? data.read_work_logs : [];
  }
  refreshUnreadIndicators();
}

async function saveReadSet(profileColumn, setObj) {
  const arr = [...setObj].sort();
  if (currentUserProfile) {
    currentUserProfile[profileColumn] = arr;
  }
  if (!currentUser) return;

  const { data, error } = await sb
    .from("user_profiles")
    .update({
      [profileColumn]: arr,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", currentUser.id)
    .select("read_daily_reviews, read_work_logs")
    .single();

  if (error) {
    console.error("Read status sync error:", error.message);
    alert("읽음 상태 DB 동기화 실패 : " + error.message);
    return;
  }

  if (data && currentUserProfile) {
    currentUserProfile.read_daily_reviews = Array.isArray(data.read_daily_reviews) ? data.read_daily_reviews : [];
    currentUserProfile.read_work_logs = Array.isArray(data.read_work_logs) ? data.read_work_logs : [];
  }
}

function getDailyReviewKey(row) {
  return String(row.review_date || "").slice(0, 10);
}

function getWorkLogKey(row) {
  return String(row.log_date || "").slice(0, 10);
}

function resetReportViewState() {
  openDailyReviewIds.clear();
  openWorkLogIds.clear();
  const subDotDR = document.getElementById("subdot-dailyreview");
  const subDotWL = document.getElementById("subdot-worklog");
  const navReportDot = document.getElementById("nav-report-dot");
  if (subDotDR) subDotDR.style.display = "none";
  if (subDotWL) subDotWL.style.display = "none";
  if (navReportDot) navReportDot.style.display = "none";
}

function refreshUnreadIndicators() {
  const readDR = getReadSet("read_daily_reviews");
  const readWL = getReadSet("read_work_logs");

  const drList = cachedDailyReviews.length ? cachedDailyReviews : FALLBACK_DAILY_REVIEWS;
  const wlList = cachedWorkLogs.length ? cachedWorkLogs : FALLBACK_WORK_LOGS;

  const hasUnreadDR = drList.some(r => {
    const key = getDailyReviewKey(r);
    return key && !readDR.has(key);
  });
  const hasUnreadWL = wlList.some(w => {
    const key = getWorkLogKey(w);
    return key && !readWL.has(key);
  });

  const subDotDR = document.getElementById("subdot-dailyreview");
  const subDotWL = document.getElementById("subdot-worklog");
  const navReportDot = document.getElementById("nav-report-dot");

  if (subDotDR) subDotDR.style.display = hasUnreadDR ? "inline-block" : "none";
  if (subDotWL) subDotWL.style.display = hasUnreadWL ? "inline-block" : "none";
  if (navReportDot) navReportDot.style.display = (hasUnreadDR || hasUnreadWL) ? "inline-block" : "none";
}

async function preloadReportDataForUnreadBadges() {
  await refreshReadStateFromDB();
  const [drRes, wlRes] = await Promise.all([
    sb.from("daily_reviews").select("*").order("review_date", { ascending: false }),
    sb.from("work_logs").select("*").order("log_date", { ascending: false })
  ]);
  cachedDailyReviews = (drRes.error || !drRes.data || drRes.data.length === 0) ? FALLBACK_DAILY_REVIEWS : drRes.data;
  cachedWorkLogs = (wlRes.error || !wlRes.data || wlRes.data.length === 0) ? FALLBACK_WORK_LOGS : wlRes.data;
  refreshUnreadIndicators();
}

document.addEventListener("visibilitychange", async () => {
  if (!document.hidden && currentUser && currentUser.email === ADMIN_EMAIL) {
    await refreshReadStateFromDB();
    const reportSec = document.getElementById("sec-report");
    if (reportSec && reportSec.classList.contains("active")) {
      if (currentReportSubTab === "dailyreview") renderDailyReviews();
      if (currentReportSubTab === "worklog") renderWorkLogs();
    }
  }
});

// =========================================================
// DEFAULT FALLBACK DATA FOR 05. REPORT SUB-TABS
// (기준일: 작업 대상일 YYYY-MM-DD 고정)
// =========================================================
const FALLBACK_MORNING_BRIEFS = [
  {
    id: 1,
    brief_date: "2026-11-26",
    headline: "2026-11-26 (목) 07:00 모닝 브리핑 — 포트폴리오 기준 스냅샷 및 시스템 현황",
    dev_strategy: `[A. 3D 조형 엔진 진단 및 인체 모델(.glb) 도입 시 4단계 파이프라인]
1. 어제 작업의 핵심 교훈 (왜 인체 ASCII가 어색했는가)
• Torus Knot은 수학적으로 연속된 단일 튜브 곡면이기 때문에 3D 호 길이(Arc-length) 기반 균일 샘플링과 법선 안쪽 오클루전(insetDepth = 0.020)이 완벽하게 맞아떨어졌습니다.
• 반면 인체(Écorché)는 곡률 변화가 극심한 다중 파츠(근육 다발·골격·관절 홈)가 겹쳐 있어, 단일 점묘(THREE.Points) ASCII 방식으로는 근육의 결(Striation)과 경계가 뭉개질 수밖에 없었습니다.
• 01. SCULPTURE는 Torus Knot ASCII 아트로 단독 유지하고, 추후 인체 모델(.glb) 구매 시에는 GLTFLoader 기반 별도 3D 뷰어 파이프라인으로 분리 설계합니다.

[B. 웹사이트 기능별 문제점 해결 및 발전 아이디어]
• 방명록 보안 및 배지 고도화: Supabase RLS 정책으로 60초 쿨다운 강제, 허니팟 스팸 필터 적용, 배지 선택 해제·소급 반영 및 관리자 지정 비공개 특수 배지 구현.
• 아카이브 관리 고도화: 관리자 전용 모달(EDIT/DELETE) 및 스토리지 이미지 연동 구현.
• 05. REPORT 통합 허브: 모닝 브리핑·분석 리포트·작업 일지 단일 허브 통합 및 미확인 알림 점 구현.

[C. 플랫폼 비교 및 자동화 해결책]
• 최우선 허브: Supabase DB(morning_briefings, daily_reviews, work_logs) 통합 및 GitHub Actions 자동 적재.
• 보조 기록: Notion(학습 아카이브 및 상세 메모), Google Sheets(키움증권 종목별 매입·평가 수치 관리) 하이브리드 운영.`,
    market_summary: `[1. 전체 시장 및 주요 지수 흐름 (11/25 전일 마감 기준)]
• 미국 S&P 500: 7,182.78 (-0.25%)
• 미국 나스닥 종합: 23,585.80 (-0.62%)
• 미국 다우존스 30: 50,182.95 (+0.33%)
• 미 국채 10년물 / VIX: 4.836% (-1.35%) / 27.08 (+12.94%)
• 한국 코스피 / 코스닥: 4,697.51 (-6.16%) / 650.64 (-2.29%)
• 원/달러 환율: 1,343.2원 (+0.8원)
• 시장 코멘트: 엔비디아 신용등급 강등 여파와 VIX 급등, 국내 증시 급락세 속에서 거시적 변동성이 확대되고 있습니다.

[2. 보유 종목 현황 (2026-11-26 임시 잔고 기준)]
• 전체 합산: 총 매입원금 12,757,240원 / 총 평가금액 9,826,179원 (-22.98%, 평가손익 -2,931,061원)
• 해외 위탁종합 (평가 6,929,834원 / -22.79%):
  - GOOGL: 8주 보유 / 평가금액 약 286만원 (-22.17%)
  - QLD: 27주 보유 / 평가금액 약 229만원 (-28.32%)
  - JEPQ: 26주 보유 / 평가금액 약 178만원 (-15.52%)
• 국내 중개형 ISA (평가 2,896,345원 / -24.45%):
  - TIME 미국나스닥100액티브: 62주 보유 / 평가금액 약 204만원 (-28.84%)
  - KODEX 미국S&P500: 39주 보유 / 평가금액 약 84만원 (-11.38%)
  - KODEX 미국배당커버드콜: 1주 보유 / 평가금액 약 1만원 (-5.76%)
• 운용 전략: 지수 추종 및 레버리지·커버드콜 비중을 점검하며 급락 구간 무리한 추격 매수를 자제하고 계획된 분할 매수 리듬을 유지합니다.`,
    news_weather: `[거시경제 일정 및 주요 이슈]
• 한국은행 금융통화위원회 기준금리 결정 및 경제전망 발표 (10:00 KST) 주시.
• 미국 금융시장은 추수감사절(Thanksgiving) 연휴로 휴장.

[경기도 평택시 오늘의 날씨 예보 (11월 26일 목요일)]
• 기온: 최저 5°C / 최고 15°C (일교차 10°C), 낮 동안 맑음.`,
    exhibition_picks: `[주간 서울·수도권 추천 전시 (매주 월요일 07:00 정기 갱신)]
• 매주 월요일 오전 7시 정기 스케줄에 맞춰 서울 및 수도권 주요 미술관·갤러리 전시 정보가 업데이트됩니다.`,
    portfolio_snapshot: {
      total_buy_krw: 12757240,
      total_eval_krw: 9826179,
      total_return_pct: -22.98,
      us_eval_krw: 6929834,
      us_return_pct: -22.79,
      kr_eval_krw: 2896345,
      kr_return_pct: -24.45,
      history: [
        { date: "11-26", buy: 1276, eval: 983 }
      ],
      holdings: [
        { ticker: "GOOGL", eval_man: 286, return_pct: -22.17 },
        { ticker: "QLD", eval_man: 229, return_pct: -28.32 },
        { ticker: "TIME 나스닥100", eval_man: 204, return_pct: -28.84 },
        { ticker: "JEPQ", eval_man: 178, return_pct: -15.52 },
        { ticker: "KODEX S&P500", eval_man: 84, return_pct: -11.38 },
        { ticker: "KODEX 배당커버드콜", eval_man: 1, return_pct: -5.76 }
      ]
    }
  }
];

const FALLBACK_DAILY_REVIEWS = [
  {
    id: 2,
    review_date: "2026-11-26",
    headline: "11/26 작업분 분석 리포트: 05. REPORT 통합 허브 완성, 방명록 특수 배지 고도화 및 리포트 스케줄 기준 정립",
    achievements: `• 01. SCULPTURE를 Torus Knot ASCII 아트로 단독화하고 기존 Swiss Grotesque 타이포그래피와 03. BIO 2단 그리드 디자인을 완전 복구했습니다.
• 상단 네비게이션을 05. REPORT 단일 허브로 통합하고 게시판 아코디언, 미확인 알림 점, 원본 리포트 전체 출력 구조를 완성했습니다.
• 방명록 도배 우려 배지를 제거하고 배지 선택 해제·기존 댓글 소급 반영 및 관리자 지정 비공개 특수 배지 시스템을 구축했습니다.
• 리포트 날짜 혼선을 방지하기 위해 기록 기준일을 '작업 대상일(전날)'로 단일화하고, 정기 생성 시각을 오전 02:00(분석 리포트)·03:00(작업 일지)으로 분리했습니다.`,
    insights: `• 제미나이 예약 작업의 발행 시각(자정 직후)과 실제 작업 대상일이 어긋나던 구조적 원인을 진단하고, DB 기준일(YYYY-MM-DD)을 작업 대상일로 고정하여 누적 관리 정확도를 높였습니다.
• 코드 수정 시 기존 CSS·레이아웃을 건드리지 않고 요청 구간만 정밀 수정하는 원칙을 확립했습니다.`,
    next_priorities: `1. Supabase SQL 정책(user_profiles·guestbook·morning_briefings·daily_reviews·work_logs) 최종 반영 확인
2. 2단계 자동화 파이프라인(GitHub Actions + 키움·Gemini API 연동 자동 DB 적재) 구축`
  },
  {
    id: 1,
    review_date: "2026-11-25",
    headline: "11/25 작업분 분석 리포트: Torus Knot 3D 곡면 엔진 진단, 웹사이트 아키텍처 정비 및 항공권 트래킹 안정화",
    achievements: `• 3D 호 길이(Arc-length) 기반 균일 샘플링과 법선 안쪽 오클루전(insetDepth = 0.020) 원리를 분석하고 인체 모델(.glb) 분리 파이프라인 설계안을 도출했습니다.
• 아카이브 관리자 제어(EDIT/DELETE 모달 및 스토리지 연동)와 방명록 60초 쿨다운·허니팟 스팸 방어 구조를 설계했습니다.
• 2027년 7월 상하이·튀르키예 다구간 항공권 자동 트래킹 및 정기 리포트 루틴을 정비했습니다.`,
    insights: `• 단일 튜브 곡면(Torus Knot)과 다중 파츠 해부학 메쉬의 렌더링 특성을 분리함으로써 시각적 완성도와 유지보수성을 동시에 확보했습니다.
• 개인 데이터를 Supabase 단일 허브로 통합하는 방향이 가장 안정적인 자동화 구조임을 확인했습니다.`,
    next_priorities: `1. 웹사이트 05. REPORT 통합 허브 프론트엔드 구현 및 디자인 복구
2. 키움증권 보유 포트폴리오 기준 스냅샷 등록`
  }
];

const FALLBACK_WORK_LOGS = [
  {
    id: 2,
    log_date: "2026-11-26",
    title: "웹 정비(Torus Knot 단독화 · 방명록 비공개 특수 배지 · 05. REPORT 통합 허브) 및 리포트 기준 확립",
    status_type: "ACTIVE",
    tools: ["Gemini 4 Hydrogen", "Three.js", "Supabase", "GitHub Actions", "Vercel", "Chart.js"],
    completed_summary: `• 26. 11. 26 (목) 완료 작업 요약
  1. 개인 웹사이트(busychronicler7800.com) 및 3D 조형 코드 정비 (Torus Knot ASCII 아트 단독화 및 원본 디자인 복구)
  2. 상단 네비게이션 슬림화 및 05. REPORT 통합 허브 구축 (모닝 브리핑 · 분석 리포트 · 작업 일지 게시판형 UI, 원본 전체 출력 및 미확인 알림 점)
  3. 방명록 보안 및 배지 고도화 (60초 쿨다운, 5회 작성 배지 제거, 선택 해제·소급 반영, 지정 계정 전용 비공개 특수 배지 부여)
  4. 리포트 날짜 기준 단일화(작업 대상일 기준) 및 정기 생성 시각 변경(02:00 분석 리포트 / 03:00 작업 일지).`,
    active_pipelines: `• 항공권 자동 트래킹 정상 가동 중
• busychronicler7800.com 프론트엔드(Vercel) 및 Supabase DB 연동 운영 중
• 정기 리포트 스케줄: 02:00 분석 리포트 / 03:00 작업 일지 / 07:00 모닝 브리핑`,
    problem_analysis: `• 문제점 1: 자정 직후 리포트 생성 시 발행일과 작업 대상일이 겹쳐 혼동 발생
  → 해결책 1: 생성 시각을 02:00 / 03:00으로 분리하고 모든 DB 기준일을 작업 대상일(전날)로 단일화 완료
• 문제점 2: 키움증권 잔고 및 리포트 데이터 수동 입력 구조
  → 해결책 2: 다음 세션 2단계 작업으로 GitHub Actions 연동 자동 DB 적재 파이프라인 구축 예정`
  },
  {
    id: 1,
    log_date: "2026-11-25",
    title: "3D 곡면 ASCII 샘플링 엔진 진단, 아카이브 관리자 제어 및 정기 자동화 파이프라인 설계",
    status_type: "ACTIVE",
    tools: ["Three.js", "Supabase", "GitHub Actions", "Vercel"],
    completed_summary: `• 26. 11. 25 (수) 완료 작업 요약
  1. Torus Knot 곡면 샘플링 및 법선 오클루전 셰이더 진단, 추후 인체(.glb) 뷰어 분리 파이프라인 설계
  2. 02. ARCHIVE 관리자 전용 수정·삭제 모달 및 Supabase Storage 연동 구조 설계
  3. 키움증권 보유 포트폴리오(해외 위탁종합 · 중개형 ISA) 기준 스냅샷 데이터 정리
  4. 상하이·튀르키예 다구간 항공권 알림 트래킹 안정화.`,
    active_pipelines: `• 항공권 자동 트래킹 가동 중
• 키움증권 포트폴리오 기준 스냅샷(총 매입 1,275만원 / 평가 982만원) 기록 유지`,
    problem_analysis: `• 문제점 1: 다중 파츠 인체 메쉬의 점묘 ASCII 경계 뭉개짐 현상
  → 해결책 1: 01. SCULPTURE는 Torus Knot으로 단독 유지하고, 인체 모델은 추후 GLTFLoader 전용 뷰어로 분리`
  }
];

// =========================================================
// SUB-PANEL 1: MORNING BRIEF & PORTFOLIO CHARTS
// =========================================================
function toggleMorningBriefComposer() {
  const box = document.getElementById("morningbrief-composer");
  const isHidden = box.style.display === "none";
  box.style.display = isHidden ? "block" : "none";
  if (isHidden && !document.getElementById("mb-date").value) {
    document.getElementById("mb-date").value = getTodayKST();
  }
}

async function saveMorningBrief() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const briefDate = document.getElementById("mb-date").value;
  const headline = document.getElementById("mb-headline").value.trim();
  const devStrategy = document.getElementById("mb-dev").value.trim();
  const marketSummary = document.getElementById("mb-market").value.trim();
  const newsWeather = document.getElementById("mb-news").value.trim();
  const exhibitionPicks = document.getElementById("mb-exhibition").value.trim();
  const snapshotRaw = document.getElementById("mb-snapshot").value.trim();
  const msgEl = document.getElementById("mb-msg");

  if (!briefDate || !headline) {
    msgEl.innerText = "브리핑 기준일과 제목을 입력하세요.";
    return;
  }

  let snapshotObj = (cachedMorningBriefs[0] && cachedMorningBriefs[0].portfolio_snapshot)
    || FALLBACK_MORNING_BRIEFS[0].portfolio_snapshot;

  if (snapshotRaw) {
    try {
      snapshotObj = JSON.parse(snapshotRaw);
    } catch (e) {
      msgEl.innerText = "PORTFOLIO SNAPSHOT JSON 형식이 올바르지 않습니다.";
      return;
    }
  }

  msgEl.innerText = "SAVING...";
  const { error } = await sb.from("morning_briefings").upsert({
    brief_date: briefDate,
    headline,
    dev_strategy: devStrategy,
    market_summary: marketSummary,
    news_weather: newsWeather,
    exhibition_picks: exhibitionPicks,
    portfolio_snapshot: snapshotObj
  }, { onConflict: "brief_date" });

  if (error) {
    msgEl.innerText = "ERROR : " + error.message;
  } else {
    msgEl.innerText = "SAVED.";
    await loadMorningBriefs();
    const selectEl = document.getElementById("brief-date-select");
    if (selectEl) {
      selectEl.value = briefDate;
      selectMorningBrief(briefDate);
    }
  }
}

async function loadMorningBriefs() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  await refreshReadStateFromDB();
  const { data, error } = await sb
    .from("morning_briefings")
    .select("*")
    .order("brief_date", { ascending: false });

  cachedMorningBriefs = (error || !data || data.length === 0) ? FALLBACK_MORNING_BRIEFS : data;

  const today = getTodayKST();
  const selectEl = document.getElementById("brief-date-select");
  selectEl.innerHTML = cachedMorningBriefs.map(b => {
    const todaySuffix = b.brief_date === today ? " · 오늘" : "";
    return `<option value="${escapeHtml(b.brief_date)}">${escapeHtml(b.brief_date)}${todaySuffix}</option>`;
  }).join("");

  selectMorningBrief(cachedMorningBriefs[0].brief_date);
}

function selectMorningBrief(dateStr) {
  const brief = cachedMorningBriefs.find(b => b.brief_date === dateStr) || cachedMorningBriefs[0];
  if (!brief) return;

  const isToday = brief.brief_date === getTodayKST();
  document.getElementById("brief-headline").innerHTML =
    `${isToday ? '<span class="today-tag" style="margin-right:8px;">오늘</span>' : ''}${escapeHtml(brief.headline || "")}`;

  const snap = brief.portfolio_snapshot || FALLBACK_MORNING_BRIEFS[0].portfolio_snapshot;
  const pnlKrw = (snap.total_eval_krw || 0) - (snap.total_buy_krw || 0);

  document.getElementById("portfolio-kpi-grid").innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">TOTAL EVALUATION (총 평가금액)</div>
      <div class="kpi-val">${Number(snap.total_eval_krw || 0).toLocaleString("ko-KR")}원</div>
      <div class="kpi-sub">매입 ${Number(snap.total_buy_krw || 0).toLocaleString("ko-KR")}원</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">TOTAL P&amp;L (총 평가손익)</div>
      <div class="kpi-val">${pnlKrw >= 0 ? "+" : ""}${pnlKrw.toLocaleString("ko-KR")}원</div>
      <div class="kpi-sub">수익률 ${Number(snap.total_return_pct || 0).toFixed(2)}%</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">US ACCOUNT (해외 위탁종합)</div>
      <div class="kpi-val">${Number(snap.us_eval_krw || 0).toLocaleString("ko-KR")}원</div>
      <div class="kpi-sub">수익률 ${Number(snap.us_return_pct || 0).toFixed(2)}%</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">KR ISA ACCOUNT (중개형 ISA)</div>
      <div class="kpi-val">${Number(snap.kr_eval_krw || 0).toLocaleString("ko-KR")}원</div>
      <div class="kpi-sub">수익률 ${Number(snap.kr_return_pct || 0).toFixed(2)}%</div>
    </div>
  `;

  renderPortfolioCharts(snap);

  document.getElementById("brief-sections-grid").innerHTML = `
    <div class="brief-card">
      <h3>01. PROJECT STRATEGY &amp; ARCHITECTURE</h3>
      <div class="brief-text">${escapeHtml(brief.dev_strategy || "")}</div>
    </div>
    <div class="brief-card">
      <h3>02. MARKET &amp; PORTFOLIO DEEP DIVE</h3>
      <div class="brief-text">${escapeHtml(brief.market_summary || "")}</div>
    </div>
    <div class="brief-card">
      <h3>03. MACRO NEWS &amp; PYEONGTAEK WEATHER</h3>
      <div class="brief-text">${escapeHtml(brief.news_weather || "")}</div>
    </div>
    <div class="brief-card">
      <h3>04. WEEKLY EXHIBITION PICKS</h3>
      <div class="brief-text">${escapeHtml(brief.exhibition_picks || "")}</div>
    </div>
  `;
}

function renderPortfolioCharts(snap) {
  Object.values(chartInstances).forEach(ch => ch && ch.destroy());
  chartInstances = {};

  const history = snap.history || [{ date: "11-26", buy: 1276, eval: 983 }];
  const holdings = snap.holdings || [];

  const commonGrid = { color: "#1f1f1f" };
  const commonTicks = { color: "#888888", font: { size: 11 } };

  chartInstances.trajectory = new Chart(document.getElementById("chart-trajectory"), {
    type: "line",
    data: {
      labels: history.map(h => h.date),
      datasets: [
        {
          label: "총 매입원금 (만원)",
          data: history.map(h => h.buy),
          borderColor: "#666666",
          borderDash: [5, 5],
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: "#666666",
          tension: 0.2
        },
        {
          label: "총 평가금액 (만원)",
          data: history.map(h => h.eval),
          borderColor: "#ffffff",
          backgroundColor: "rgba(255,255,255,0.08)",
          borderWidth: 2,
          pointRadius: 5,
          pointBackgroundColor: "#ffffff",
          fill: true,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cccccc" } } },
      scales: { x: { grid: commonGrid, ticks: commonTicks }, y: { grid: commonGrid, ticks: commonTicks } }
    }
  });

  chartInstances.allocation = new Chart(document.getElementById("chart-allocation"), {
    type: "doughnut",
    data: {
      labels: holdings.map(h => h.ticker),
      datasets: [{
        data: holdings.map(h => h.eval_man),
        backgroundColor: ["#ffffff", "#cccccc", "#999999", "#666666", "#404040", "#222222"],
        borderColor: "#000000",
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "right", labels: { color: "#cccccc", font: { size: 11 } } } }
    }
  });

  chartInstances.returns = new Chart(document.getElementById("chart-returns"), {
    type: "bar",
    data: {
      labels: holdings.map(h => h.ticker),
      datasets: [{
        label: "수익률 (%)",
        data: holdings.map(h => h.return_pct),
        backgroundColor: holdings.map(h => h.return_pct >= 0 ? "#ffffff" : "#777777"),
        borderColor: "#ffffff",
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { grid: commonGrid, ticks: commonTicks }, y: { grid: commonGrid, ticks: commonTicks } }
    }
  });
}

// =========================================================
// SUB-PANEL 2: DAILY REVIEW
// =========================================================
function toggleDailyReviewComposer() {
  const box = document.getElementById("dailyreview-composer");
  const isHidden = box.style.display === "none";
  box.style.display = isHidden ? "block" : "none";
  if (isHidden && !document.getElementById("dr-date").value) {
    document.getElementById("dr-date").value = getYesterdayKST();
  }
}

async function loadDailyReviews() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  await refreshReadStateFromDB();
  const { data, error } = await sb
    .from("daily_reviews")
    .select("*")
    .order("review_date", { ascending: false });

  cachedDailyReviews = (error || !data || data.length === 0) ? FALLBACK_DAILY_REVIEWS : data;
  renderDailyReviews();
  refreshUnreadIndicators();
}

function renderDailyReviews() {
  const listEl = document.getElementById("dailyreview-list");
  const readSet = getReadSet("read_daily_reviews");
  const today = getTodayKST();
  const yesterday = getYesterdayKST();

  if (!cachedDailyReviews || cachedDailyReviews.length === 0) {
    listEl.innerHTML = `<p style="font-size:0.84rem; color:var(--muted);">등록된 분석 리포트가 없습니다.</p>`;
    return;
  }

  listEl.innerHTML = cachedDailyReviews.map(r => {
    const key = getDailyReviewKey(r);
    const isUnread = !readSet.has(key);
    const isToday = r.review_date === today;
    const isYesterday = r.review_date === yesterday;
    const isOpen = openDailyReviewIds.has(key);

    return `
      <div class="board-row-item ${isUnread ? "unread" : ""} ${isOpen ? "open" : ""}" id="dr-row-${escapeHtml(key)}">
        <div class="board-row-header" onclick="toggleDailyReviewItem('${escapeHtml(key)}')">
          <div class="board-row-left">
            <span class="board-date-mono">${escapeHtml(r.review_date)}</span>
            ${isToday ? `<span class="today-tag">오늘</span>` : (isYesterday ? `<span class="today-tag">전일 작업</span>` : "")}
            <span class="board-title-text">${escapeHtml(r.headline)}</span>
          </div>
          <div class="board-row-right">
            ${isUnread ? `<span class="unread-dot" title="미확인 리포트"></span>` : ""}
          </div>
        </div>
        <div class="board-row-body">
          <div class="log-detail-block">
            <h3>1. ACHIEVEMENTS / 완료한 주요 작업</h3>
            <div class="log-detail-content">${escapeHtml(r.achievements || "기록 없음")}</div>
          </div>
          <div class="log-detail-block">
            <h3>2. INSIGHTS / 핵심 리뷰 및 인사이트</h3>
            <div class="log-detail-content">${escapeHtml(r.insights || "기록 없음")}</div>
          </div>
          <div class="log-detail-block">
            <h3>3. NEXT PRIORITIES / 다음 우선순위 과제</h3>
            <div class="log-detail-content">${escapeHtml(r.next_priorities || "기록 없음")}</div>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

async function toggleDailyReviewItem(key) {
  let needsDbSync = false;
  let nextSet = null;

  if (openDailyReviewIds.has(key)) {
    openDailyReviewIds.delete(key);
  } else {
    openDailyReviewIds.add(key);
    const readSet = getReadSet("read_daily_reviews");
    if (!readSet.has(key)) {
      readSet.add(key);
      nextSet = readSet;
      needsDbSync = true;
      if (currentUserProfile) {
        currentUserProfile.read_daily_reviews = [...readSet].sort();
      }
    }
  }

  renderDailyReviews();
  refreshUnreadIndicators();

  if (needsDbSync && nextSet) {
    await saveReadSet("read_daily_reviews", nextSet);
  }
}

async function markAllDailyReviewsRead() {
  const readSet = getReadSet("read_daily_reviews");
  cachedDailyReviews.forEach(r => {
    const key = getDailyReviewKey(r);
    if (key) readSet.add(key);
  });
  if (currentUserProfile) {
    currentUserProfile.read_daily_reviews = [...readSet].sort();
  }
  renderDailyReviews();
  refreshUnreadIndicators();
  await saveReadSet("read_daily_reviews", readSet);
}

async function saveDailyReview() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const reviewDate = document.getElementById("dr-date").value;
  const headline = document.getElementById("dr-headline").value.trim();
  const achievements = document.getElementById("dr-achievements").value.trim();
  const insights = document.getElementById("dr-insights").value.trim();
  const nextPriorities = document.getElementById("dr-priorities").value.trim();
  const msgEl = document.getElementById("dr-msg");

  if (!reviewDate || !headline) { msgEl.innerText = "작업 대상일과 제목을 입력하세요."; return; }
  msgEl.innerText = "SAVING...";

  const { error } = await sb.from("daily_reviews").upsert({
    review_date: reviewDate,
    headline,
    achievements,
    insights,
    next_priorities: nextPriorities
  }, { onConflict: "review_date" });

  if (error) {
    msgEl.innerText = "ERROR : " + error.message;
  } else {
    msgEl.innerText = "SAVED.";
    loadDailyReviews();
  }
}

// =========================================================
// SUB-PANEL 3: WORK LOG
// =========================================================
function toggleWorkLogComposer() {
  const box = document.getElementById("worklog-composer");
  const isHidden = box.style.display === "none";
  box.style.display = isHidden ? "block" : "none";
  if (isHidden && !document.getElementById("wl-date").value) {
    document.getElementById("wl-date").value = getYesterdayKST();
  }
}

async function loadWorkLogs() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  await refreshReadStateFromDB();
  const { data, error } = await sb
    .from("work_logs")
    .select("*")
    .order("log_date", { ascending: false });

  cachedWorkLogs = (error || !data || data.length === 0) ? FALLBACK_WORK_LOGS : data;
  renderWorkLogs();
  refreshUnreadIndicators();
}

function renderWorkLogs() {
  const listEl = document.getElementById("worklog-list");
  const yFilter = document.getElementById("filter-wl-year").value;
  const mFilter = document.getElementById("filter-wl-month").value;
  const tFilter = document.getElementById("filter-wl-type").value;
  const readSet = getReadSet("read_work_logs");
  const today = getTodayKST();
  const yesterday = getYesterdayKST();

  const filtered = cachedWorkLogs.filter(item => {
    const [yy, mm] = (item.log_date || "").split("-");
    if (yFilter !== "ALL" && yy !== yFilter) return false;
    if (mFilter !== "ALL" && mm !== mFilter) return false;
    if (tFilter !== "ALL" && item.status_type !== tFilter) return false;
    return true;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<p style="font-size:0.84rem; color:var(--muted);">선택한 조건에 해당하는 작업 일지가 없습니다.</p>`;
    return;
  }

  listEl.innerHTML = filtered.map(item => {
    const key = getWorkLogKey(item);
    const isUnread = !readSet.has(key);
    const isToday = item.log_date === today;
    const isYesterday = item.log_date === yesterday;
    const isOpen = openWorkLogIds.has(key);
    const tools = Array.isArray(item.tools) ? item.tools : [];

    return `
      <div class="board-row-item ${isUnread ? "unread" : ""} ${isOpen ? "open" : ""}" id="wl-row-${escapeHtml(key)}">
        <div class="board-row-header" onclick="toggleWorkLogItem('${escapeHtml(key)}')">
          <div class="board-row-left">
            <span class="board-date-mono">${escapeHtml(item.log_date)}</span>
            ${isToday ? `<span class="today-tag">오늘</span>` : (isYesterday ? `<span class="today-tag">전일 작업</span>` : "")}
            <span class="board-title-text">${escapeHtml(item.title)}</span>
          </div>
          <div class="board-row-right">
            ${isUnread ? `<span class="unread-dot" title="미확인 작업 일지"></span>` : ""}
          </div>
        </div>
        <div class="board-row-body">
          ${tools.length ? `
            <div class="tool-chips">
              ${tools.map(t => `<span class="tool-chip">${escapeHtml(t)}</span>`).join("")}
            </div>
          ` : ""}
          <div class="log-detail-block">
            <h3>1. COMPLETED WORK / 일자별 작업 기록</h3>
            <div class="log-detail-content">${escapeHtml(item.completed_summary || "기록 없음")}</div>
          </div>
          <div class="log-detail-block">
            <h3>2. ACTIVE AUTOMATIONS &amp; PORTFOLIO / 실행 중인 자동화 및 투자 현황</h3>
            <div class="log-detail-content">${escapeHtml(item.active_pipelines || "기록 없음")}</div>
          </div>
          <div class="log-detail-block">
            <h3>3. DIAGNOSIS, SOLUTIONS &amp; STUDY ARCHIVE / 문제점 분석 및 학습·성취 기록</h3>
            <div class="log-detail-content">${escapeHtml(item.problem_analysis || "기록 없음")}</div>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

async function toggleWorkLogItem(key) {
  let needsDbSync = false;
  let nextSet = null;

  if (openWorkLogIds.has(key)) {
    openWorkLogIds.delete(key);
  } else {
    openWorkLogIds.add(key);
    const readSet = getReadSet("read_work_logs");
    if (!readSet.has(key)) {
      readSet.add(key);
      nextSet = readSet;
      needsDbSync = true;
      if (currentUserProfile) {
        currentUserProfile.read_work_logs = [...readSet].sort();
      }
    }
  }

  renderWorkLogs();
  refreshUnreadIndicators();

  if (needsDbSync && nextSet) {
    await saveReadSet("read_work_logs", nextSet);
  }
}

async function markAllWorkLogsRead() {
  const readSet = getReadSet("read_work_logs");
  cachedWorkLogs.forEach(w => {
    const key = getWorkLogKey(w);
    if (key) readSet.add(key);
  });
  if (currentUserProfile) {
    currentUserProfile.read_work_logs = [...readSet].sort();
  }
  renderWorkLogs();
  refreshUnreadIndicators();
  await saveReadSet("read_work_logs", readSet);
}

async function saveWorkLog() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const logDate = document.getElementById("wl-date").value;
  const statusType = document.getElementById("wl-status").value;
  const toolsRaw = document.getElementById("wl-tools").value;
  const title = document.getElementById("wl-title").value.trim();
  const completedSummary = document.getElementById("wl-completed").value.trim();
  const activePipelines = document.getElementById("wl-pipelines").value.trim();
  const problemAnalysis = document.getElementById("wl-analysis").value.trim();
  const msgEl = document.getElementById("wl-msg");

  if (!logDate || !title) { msgEl.innerText = "작업 대상일과 1줄 제목을 입력하세요."; return; }
  msgEl.innerText = "SAVING...";

  const tools = toolsRaw.split(",").map(s => s.trim()).filter(Boolean);
  const { error } = await sb.from("work_logs").upsert({
    log_date: logDate,
    title,
    status_type: statusType,
    tools,
    completed_summary: completedSummary,
    active_pipelines: activePipelines,
    problem_analysis: problemAnalysis
  }, { onConflict: "log_date" });

  if (error) {
    msgEl.innerText = "ERROR : " + error.message;
  } else {
    msgEl.innerText = "SAVED.";
    loadWorkLogs();
  }
}
