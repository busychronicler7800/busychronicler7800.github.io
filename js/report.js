// =========================================================
// 05. REPORT HUB — DB READ SYNC + REALTIME CONFIG + REPORTS
// =========================================================
let cachedDailyReviews = [];
let cachedWorkLogs = [];
let cachedMorningBriefs = [];
let openDailyReviewIds = new Set();
let openWorkLogIds = new Set();
let chartInstances = {};

// =========================================================
// REALTIME AI REPORT CONFIG (SUPABASE report_config)
// =========================================================
async function toggleReportConfigPanel() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const panel = document.getElementById("report-config-panel");
  const btn = document.getElementById("btn-toggle-report-config");
  if (!panel) return;

  const isOpening = panel.style.display === "none";
  panel.style.display = isOpening ? "block" : "none";
  if (btn) btn.classList.toggle("active", isOpening);

  if (isOpening) {
    await loadReportConfig();
  }
}

async function loadReportConfig() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const msgEl = document.getElementById("rc-msg");
  const updatedEl = document.getElementById("rc-updated-at");
  if (msgEl) msgEl.innerText = "LOADING CONFIG...";

  const { data, error } = await sb
    .from("report_config")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    if (msgEl) msgEl.innerText = "LOAD ERROR : " + error.message;
    return;
  }

  if (data) {
    document.getElementById("rc-roadmap").value = data.roadmap_context || "";
    document.getElementById("rc-extra").value = data.extra_instructions || "";
    if (updatedEl && data.updated_at) {
      updatedEl.innerText = "LAST UPDATED : " + new Date(data.updated_at).toLocaleString("ko-KR");
    }
  }
  if (msgEl) msgEl.innerText = "";
}

async function saveReportConfig() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const roadmapContext = document.getElementById("rc-roadmap").value.trim();
  const extraInstructions = document.getElementById("rc-extra").value.trim();
  const msgEl = document.getElementById("rc-msg");
  const updatedEl = document.getElementById("rc-updated-at");

  if (msgEl) msgEl.innerText = "SAVING...";
  const nowIso = new Date().toISOString();

  const { error } = await sb.from("report_config").upsert({
    id: 1,
    roadmap_context: roadmapContext,
    extra_instructions: extraInstructions,
    updated_at: nowIso
  }, { onConflict: "id" });

  if (error) {
    if (msgEl) msgEl.innerText = "SAVE ERROR : " + error.message;
  } else {
    if (msgEl) msgEl.innerText = "SAVED. 다음 자동 리포트부터 즉시 반영됩니다.";
    if (updatedEl) updatedEl.innerText = "LAST UPDATED : " + new Date(nowIso).toLocaleString("ko-KR");
  }
}

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
// =========================================================
const FALLBACK_MORNING_BRIEFS = [
  {
    id: 1,
    brief_date: "2026-11-26",
    headline: "2026-11-26 (목) 07:00 모닝 브리핑 — 포트폴리오 기준 스냅샷 및 시스템 현황",
    dev_strategy: `[A. 3D 조형 엔진 진단 및 인체 모델(.glb) 도입 시 4단계 파이프라인]
• 01. SCULPTURE는 Torus Knot ASCII 아트로 단독 유지하고, 추후 인체 모델(.glb) 구매 시 GLTFLoader 기반 별도 뷰어로 분리 설계합니다.`,
    market_summary: `[2026-11-26 임시 잔고 기준]
• 총 매입원금 12,757,240원 / 총 평가금액 9,826,179원 (-22.98%)`,
    news_weather: `[경기도 평택시 오늘의 날씨 예보]
• 기온: 최저 5°C / 최고 15°C`,
    exhibition_picks: `[주간 서울·수도권 추천 전시 (매주 월요일 07:00 정기 갱신)]
• 매주 월요일 오전 7시 정기 스케줄에 맞춰 업데이트됩니다.`,
    portfolio_snapshot: {
      total_buy_krw: 12757240,
      total_eval_krw: 9826179,
      total_return_pct: -22.98,
      us_eval_krw: 6929834,
      us_return_pct: -22.79,
      kr_eval_krw: 2896345,
      kr_return_pct: -24.45,
      history: [{ date: "11-26", buy: 1276, eval: 983 }],
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
    achievements: "• 05. REPORT 통합 허브 및 방명록 배지 고도화 완료",
    insights: "• 작업 대상일(YYYY-MM-DD) 단일 기준 확립",
    next_priorities: "1. 자동화 파이프라인 구축"
  }
];

const FALLBACK_WORK_LOGS = [
  {
    id: 2,
    log_date: "2026-11-26",
    title: "웹 정비(Torus Knot 단독화 · 방명록 비공개 특수 배지 · 05. REPORT 통합 허브) 및 리포트 기준 확립",
    status_type: "ACTIVE",
    tools: ["Gemini 4 Hydrogen", "Three.js", "Supabase", "GitHub Actions", "Chart.js"],
    completed_summary: "• 26. 11. 26 (목) 완료 작업 요약",
    active_pipelines: "• 정기 리포트 자동화 파이프라인 가동 중",
    problem_analysis: "• DB 기반 자동화 연동 진행 중"
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
    portfolio_snapshot: snapshotObj,
    generated_model: "MANUAL"
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
  const modelTag = brief.generated_model
    ? `<span class="tool-chip" style="margin-left:8px; font-weight:400; vertical-align:middle;">MODEL : ${escapeHtml(brief.generated_model.toUpperCase())}</span>`
    : "";
  document.getElementById("brief-headline").innerHTML =
    `${isToday ? '<span class="today-tag" style="margin-right:8px;">오늘</span>' : ''}${escapeHtml(brief.headline || "")}${modelTag}`;

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
            ${r.generated_model ? `<span class="tool-chip">${escapeHtml(r.generated_model.toUpperCase())}</span>` : ""}
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
    next_priorities: nextPriorities,
    generated_model: "MANUAL"
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
            ${item.generated_model ? `<span class="tool-chip">${escapeHtml(item.generated_model.toUpperCase())}</span>` : ""}
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
    problem_analysis: problemAnalysis,
    generated_model: "MANUAL"
  }, { onConflict: "log_date" });

  if (error) {
    msgEl.innerText = "ERROR : " + error.message;
  } else {
    msgEl.innerText = "SAVED.";
    loadWorkLogs();
  }
}
