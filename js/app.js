// =========================================================
// 1. SUPABASE & CONSTANTS CONFIGURATION
// =========================================================
const SUPABASE_URL = "https://busychronicler7800-github-io-delta.vercel.app";
const SUPABASE_ANON_KEY = "sb_publishable_A3BcYO4bYJZGBbKmFivEaw_vTQqYIae";
const ADMIN_EMAIL = "kangsihoo0530@gmail.com";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentUser = null;
let currentUserProfile = null;
let currentReportSubTab = "morningbrief";
let cachedArchives = [];
let cooldownInterval = null;

const BADGE_CATALOG = [
  { code: "guest",     label: "GUEST",       desc: "기본 제공 배지" },
  { code: "chronicle", label: "OBSERVER",    desc: "기본 제공 배지" },
  { code: "visit_3",   label: "VISITOR III", desc: "서로 다른 날 3회 접속" },
  { code: "visit_10",  label: "REGULAR",     desc: "서로 다른 날 10회 접속" },
  { code: "scribe_1",  label: "FIRST LOG",   desc: "방명록 첫 글 작성" },
  { code: "admin",     label: "ARCHITECT",   desc: "관리자 전용 배지" }
];

function getTodayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function getYesterdayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// =========================================================
// 2. NAVIGATION & REPORT SUB-TABS
// =========================================================
function switchTab(tabName) {
  if (tabName === "report" && (!currentUser || currentUser.email !== ADMIN_EMAIL)) {
    tabName = "anatomy";
  }

  document.querySelectorAll(".section").forEach(sec => sec.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.remove("active"));
  document.getElementById("sec-" + tabName).classList.add("active");
  document.getElementById("nav-" + tabName).classList.add("active");

  if (tabName === "anatomy") resizeAnatomyViewport();
  if (tabName === "archive") loadArchives();
  if (tabName === "guestbook") loadGuestbook();
  if (tabName === "report") switchReportSubTab(currentReportSubTab);
}

function switchReportSubTab(subName) {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  currentReportSubTab = subName;

  document.querySelectorAll(".report-subpanel").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".report-subnav .btn-outline").forEach(btn => btn.classList.remove("active"));

  document.getElementById("sub-" + subName).classList.add("active");
  document.getElementById("subnav-" + subName).classList.add("active");

  if (subName === "morningbrief") loadMorningBriefs();
  if (subName === "dailyreview") loadDailyReviews();
  if (subName === "worklog") loadWorkLogs();
}

// =========================================================
// 3. AUTHENTICATION & PRIVATE SPECIAL BADGE SYSTEM
// =========================================================
function setAuthMode(mode) {
  const isSignIn = mode === "signin";
  document.getElementById("tab-auth-signin").classList.toggle("active", isSignIn);
  document.getElementById("tab-auth-signup").classList.toggle("active", !isSignIn);
  document.getElementById("form-signin").style.display = isSignIn ? "block" : "none";
  document.getElementById("form-signup").style.display = isSignIn ? "none" : "block";
  document.getElementById("auth-msg").innerText = "";
}

async function updateAuthUI(user) {
  currentUser = user;
  const headerStatus = document.getElementById("header-auth-status");
  const loggedOutBox = document.getElementById("auth-logged-out");
  const loggedInBox = document.getElementById("auth-logged-in");
  const userInfo = document.getElementById("auth-user-info");
  const adminArchiveBox = document.getElementById("admin-archive-box");
  const badgePanel = document.getElementById("badge-panel");
  const adminGrantBox = document.getElementById("admin-badge-grant-box");
  const adminNavEls = document.querySelectorAll(".admin-only");

  if (user) {
    const isAdmin = user.email === ADMIN_EMAIL;
    headerStatus.innerHTML = `SIGNED IN : ${escapeHtml(user.email)} ${isAdmin ? '<span class="badge-admin">ADMIN</span>' : ''}`;
    loggedOutBox.style.display = "none";
    loggedInBox.style.display = "flex";
    userInfo.innerHTML = `SIGNED IN AS <strong>${escapeHtml(user.email)}</strong> ${isAdmin ? '<span class="badge-admin">ADMIN</span>' : ''}`;
    adminArchiveBox.style.display = isAdmin ? "block" : "none";
    badgePanel.style.display = "block";
    adminGrantBox.style.display = isAdmin ? "block" : "none";
    adminNavEls.forEach(el => {
      el.style.display = isAdmin ? (el.classList.contains("nav-divider") ? "inline-block" : "inline-flex") : "none";
    });

    const savedName = localStorage.getItem("gb_display_name_" + user.id);
    if (savedName && !document.getElementById("gb-name").value) {
      document.getElementById("gb-name").value = savedName;
    }

    await syncUserProfileAndBadges(user);
    if (isAdmin && typeof preloadReportDataForUnreadBadges === "function") {
      await preloadReportDataForUnreadBadges();
    }
  } else {
    currentUserProfile = null;
    headerStatus.innerText = "GUEST MODE";
    loggedOutBox.style.display = "block";
    loggedInBox.style.display = "none";
    adminArchiveBox.style.display = "none";
    badgePanel.style.display = "none";
    adminGrantBox.style.display = "none";
    adminNavEls.forEach(el => el.style.display = "none");
    if (typeof resetReportViewState === "function") {
      resetReportViewState();
    }
  }
}

async function syncUserProfileAndBadges(user) {
  const today = getTodayKST();
  const isAdmin = user.email === ADMIN_EMAIL;
  const defaultBadges = isAdmin ? ["guest", "chronicle", "admin"] : ["guest", "chronicle"];

  const { data, error } = await sb
    .from("user_profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    currentUserProfile = {
      user_id: user.id,
      email: user.email,
      visit_count: 1,
      post_count: 0,
      unlocked_badges: defaultBadges,
      selected_badge: isAdmin ? "admin" : "guest",
      show_badge: true,
      read_daily_reviews: [],
      read_work_logs: []
    };
    renderBadgePanel();
    return;
  }

  if (!data) {
    const newProfile = {
      user_id: user.id,
      email: user.email,
      visit_count: 1,
      last_visit_date: today,
      post_count: 0,
      unlocked_badges: defaultBadges,
      selected_badge: isAdmin ? "admin" : "guest",
      show_badge: true,
      read_daily_reviews: [],
      read_work_logs: []
    };
    const { data: inserted } = await sb.from("user_profiles").insert(newProfile).select().single();
    currentUserProfile = inserted || newProfile;
  } else {
    let visitCount = data.visit_count || 1;
    let lastDate = data.last_visit_date;
    let unlocked = Array.isArray(data.unlocked_badges)
      ? data.unlocked_badges.filter(c => c !== "scribe_5")
      : [...defaultBadges];
    let changed = (Array.isArray(data.unlocked_badges) && data.unlocked_badges.includes("scribe_5")) || !data.email;

    if (lastDate !== today) {
      visitCount += 1;
      lastDate = today;
      changed = true;
    }
    if (isAdmin && !unlocked.includes("admin")) { unlocked.push("admin"); changed = true; }
    if (visitCount >= 3 && !unlocked.includes("visit_3")) { unlocked.push("visit_3"); changed = true; }
    if (visitCount >= 10 && !unlocked.includes("visit_10")) { unlocked.push("visit_10"); changed = true; }

    let nextSelected = data.selected_badge === "scribe_5" ? null : data.selected_badge;
    let nextShow = data.selected_badge === "scribe_5" ? false : data.show_badge;

    if (changed) {
      const { data: updated } = await sb
        .from("user_profiles")
        .update({
          email: user.email,
          visit_count: visitCount,
          last_visit_date: lastDate,
          unlocked_badges: unlocked,
          selected_badge: nextSelected,
          show_badge: nextShow,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", user.id)
        .select()
        .single();
      currentUserProfile = updated || {
        ...data,
        email: user.email,
        visit_count: visitCount,
        unlocked_badges: unlocked,
        selected_badge: nextSelected,
        show_badge: nextShow
      };
    } else {
      currentUserProfile = data;
    }

    if (!Array.isArray(currentUserProfile.read_daily_reviews)) {
      currentUserProfile.read_daily_reviews = [];
    }
    if (!Array.isArray(currentUserProfile.read_work_logs)) {
      currentUserProfile.read_work_logs = [];
    }
  }
  renderBadgePanel();
}

function getUserPrivateSpecialBadges(profile) {
  if (!profile || !Array.isArray(profile.unlocked_badges)) return [];
  return profile.unlocked_badges
    .filter(code => typeof code === "string" && code.startsWith("custom:"))
    .map(code => {
      const label = code.slice("custom:".length).trim();
      return {
        code,
        label,
        desc: "지정 계정 전용 특수 배지"
      };
    })
    .filter(item => item.label.length > 0);
}

function resolveBadgeLabelByCode(code) {
  if (!code) return null;
  if (typeof code === "string" && code.startsWith("custom:")) {
    return code.slice("custom:".length).trim() || null;
  }
  const found = BADGE_CATALOG.find(b => b.code === code);
  return found ? found.label : null;
}

function renderBadgePanel() {
  if (!currentUserProfile) return;
  const statsEl = document.getElementById("badge-stats-text");
  const clearBtn = document.getElementById("btn-clear-badge");
  const gridEl = document.getElementById("badge-selector-grid");

  const unlocked = (currentUserProfile.unlocked_badges || ["guest", "chronicle"]).filter(c => c !== "scribe_5");
  const privateSpecials = getUserPrivateSpecialBadges(currentUserProfile);
  const totalUnlockedCount = BADGE_CATALOG.filter(b => unlocked.includes(b.code)).length + privateSpecials.length;
  const totalCatalogCount = BADGE_CATALOG.length + privateSpecials.length;

  const hasActiveBadge = Boolean(currentUserProfile.selected_badge) && currentUserProfile.show_badge !== false;
  const selected = hasActiveBadge ? currentUserProfile.selected_badge : null;

  statsEl.innerText = `VISITS : ${currentUserProfile.visit_count || 1} · POSTS : ${currentUserProfile.post_count || 0} · BADGES (${totalUnlockedCount}/${totalCatalogCount})`;
  clearBtn.classList.toggle("active", !selected);

  const noneChipHtml = `
    <button
      type="button"
      class="badge-chip ${!selected ? "selected" : ""}"
      onclick="clearUserBadge()"
      title="배지를 표시하지 않고 해제합니다"
    >
      <span>[NONE]</span>
      <span class="sub">배지 없음 (선택 해제)</span>
    </button>
  `;

  const publicBadgesHtml = BADGE_CATALOG.map(b => {
    const isUnlocked = unlocked.includes(b.code);
    const isSelected = selected === b.code;
    return `
      <button
        type="button"
        class="badge-chip ${isSelected ? "selected" : ""} ${!isUnlocked ? "locked" : ""}"
        ${isUnlocked ? `onclick="handleBadgeChipClick('${escapeHtml(b.code)}')"` : "disabled"}
        title="${escapeHtml(b.desc)}"
      >
        <span>[${escapeHtml(b.label)}]</span>
        <span class="sub">${escapeHtml(b.desc)}</span>
      </button>
    `;
  }).join("");

  const privateBadgesHtml = privateSpecials.map(sbItem => {
    const isSelected = selected === sbItem.code;
    return `
      <button
        type="button"
        class="badge-chip special-badge ${isSelected ? "selected" : ""}"
        onclick="handleBadgeChipClick('${escapeHtml(sbItem.code)}')"
        title="${escapeHtml(sbItem.desc)}"
      >
        <span>[${escapeHtml(sbItem.label)}]</span>
        <span class="sub">${escapeHtml(sbItem.desc)}</span>
      </button>
    `;
  }).join("");

  gridEl.innerHTML = noneChipHtml + publicBadgesHtml + privateBadgesHtml;
}

function handleBadgeChipClick(badgeCode) {
  if (!currentUserProfile) return;
  const isAlreadySelected = currentUserProfile.selected_badge === badgeCode && currentUserProfile.show_badge !== false;
  if (isAlreadySelected) {
    clearUserBadge();
  } else {
    selectUserBadge(badgeCode);
  }
}

async function selectUserBadge(badgeCode) {
  if (!currentUser || !currentUserProfile) return;
  const msgEl = document.getElementById("badge-sync-msg");
  currentUserProfile.selected_badge = badgeCode;
  currentUserProfile.show_badge = true;
  renderBadgePanel();

  const newLabel = resolveBadgeLabelByCode(badgeCode);
  msgEl.innerText = `배지 [${newLabel}] 적용 및 기존 방명록 동기화 중...`;

  await sb
    .from("user_profiles")
    .update({ selected_badge: badgeCode, show_badge: true, updated_at: new Date().toISOString() })
    .eq("user_id", currentUser.id);

  const { error: gbErr } = await sb
    .from("guestbook")
    .update({ badge_label: newLabel })
    .eq("user_id", currentUser.id);

  if (gbErr) {
    msgEl.innerText = "프로필 저장 완료 (기존 댓글 반영을 위해 Supabase UPDATE RLS 정책을 확인해 주세요).";
  } else {
    msgEl.innerText = `기존에 작성한 모든 방명록 댓글에 [${newLabel}] 배지가 반영되었습니다.`;
  }
  await loadGuestbook();
}

async function clearUserBadge() {
  if (!currentUser || !currentUserProfile) return;
  const msgEl = document.getElementById("badge-sync-msg");
  currentUserProfile.selected_badge = null;
  currentUserProfile.show_badge = false;
  renderBadgePanel();

  msgEl.innerText = "배지 선택 해제 및 기존 방명록 동기화 중...";

  await sb
    .from("user_profiles")
    .update({ selected_badge: null, show_badge: false, updated_at: new Date().toISOString() })
    .eq("user_id", currentUser.id);

  const { error: gbErr } = await sb
    .from("guestbook")
    .update({ badge_label: null })
    .eq("user_id", currentUser.id);

  if (gbErr) {
    msgEl.innerText = "배지가 해제되었습니다 (기존 댓글 반영을 위해 Supabase UPDATE RLS 정책을 확인해 주세요).";
  } else {
    msgEl.innerText = "배지가 해제되었으며 기존에 작성한 모든 방명록 댓글에서도 제거되었습니다.";
  }
  await loadGuestbook();
}

function getActiveBadgeLabelForPost() {
  if (!currentUserProfile || currentUserProfile.show_badge === false || !currentUserProfile.selected_badge) {
    return null;
  }
  return resolveBadgeLabelByCode(currentUserProfile.selected_badge);
}

async function grantSpecialBadge() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const targetEmail = document.getElementById("grant-target-email").value.trim().toLowerCase();
  const rawLabel = document.getElementById("grant-badge-label").value.trim() || "테스트용 부여 배지";
  const statusEl = document.getElementById("grant-status-msg");

  if (!targetEmail) {
    statusEl.innerText = "특수 배지를 부여할 대상 계정 이메일을 입력하세요.";
    return;
  }

  const badgeCode = `custom:${rawLabel}`;
  statusEl.innerText = `${targetEmail} 계정에 [${rawLabel}] 배지 부여 중...`;

  const { data: targetProfile, error: fetchErr } = await sb
    .from("user_profiles")
    .select("*")
    .ilike("email", targetEmail)
    .maybeSingle();

  if (fetchErr) {
    statusEl.innerText = "조회 오류 : " + fetchErr.message;
    return;
  }
  if (!targetProfile) {
    statusEl.innerText = "해당 이메일의 프로필을 찾을 수 없습니다. 대상 계정이 1회 이상 로그인한 상태여야 합니다.";
    return;
  }

  const unlocked = Array.isArray(targetProfile.unlocked_badges) ? [...targetProfile.unlocked_badges] : ["guest", "chronicle"];
  if (!unlocked.includes(badgeCode)) {
    unlocked.push(badgeCode);
  }

  const { error: upErr } = await sb
    .from("user_profiles")
    .update({
      unlocked_badges: unlocked,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", targetProfile.user_id);

  if (upErr) {
    statusEl.innerText = "부여 오류 (관리자 user_profiles RLS 정책 확인 필요) : " + upErr.message;
    return;
  }

  if (targetProfile.user_id === currentUser.id) {
    currentUserProfile.unlocked_badges = unlocked;
    renderBadgePanel();
  }

  statusEl.innerText = `완료 : ${targetEmail} 계정에 [${rawLabel}] 특수 배지가 부여되었습니다. (해당 계정 본인에게만 표시됩니다)`;
}

async function revokeSpecialBadge() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const targetEmail = document.getElementById("grant-target-email").value.trim().toLowerCase();
  const rawLabel = document.getElementById("grant-badge-label").value.trim() || "테스트용 부여 배지";
  const statusEl = document.getElementById("grant-status-msg");

  if (!targetEmail) {
    statusEl.innerText = "특수 배지를 회수할 대상 계정 이메일을 입력하세요.";
    return;
  }

  const badgeCode = `custom:${rawLabel}`;
  statusEl.innerText = `${targetEmail} 계정에서 [${rawLabel}] 배지 회수 중...`;

  const { data: targetProfile, error: fetchErr } = await sb
    .from("user_profiles")
    .select("*")
    .ilike("email", targetEmail)
    .maybeSingle();

  if (fetchErr || !targetProfile) {
    statusEl.innerText = fetchErr ? "조회 오류 : " + fetchErr.message : "대상 계정 프로필을 찾을 수 없습니다.";
    return;
  }

  const unlocked = (Array.isArray(targetProfile.unlocked_badges) ? targetProfile.unlocked_badges : [])
    .filter(c => c !== badgeCode);
  const isCurrentlyWearing = targetProfile.selected_badge === badgeCode;

  const { error: upErr } = await sb
    .from("user_profiles")
    .update({
      unlocked_badges: unlocked,
      selected_badge: isCurrentlyWearing ? null : targetProfile.selected_badge,
      show_badge: isCurrentlyWearing ? false : targetProfile.show_badge,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", targetProfile.user_id);

  if (upErr) {
    statusEl.innerText = "회수 오류 : " + upErr.message;
    return;
  }

  if (targetProfile.user_id === currentUser.id) {
    currentUserProfile.unlocked_badges = unlocked;
    if (isCurrentlyWearing) {
      currentUserProfile.selected_badge = null;
      currentUserProfile.show_badge = false;
    }
    renderBadgePanel();
  }

  statusEl.innerText = `완료 : ${targetEmail} 계정에서 [${rawLabel}] 특수 배지가 회수되었습니다.`;
}

async function handleSignUp() {
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;
  const confirmPw = document.getElementById("signup-password-confirm").value;
  const msgEl = document.getElementById("auth-msg");

  if (!email) { msgEl.innerText = "이메일 주소를 입력하세요."; return; }
  if (password.length < 6) { msgEl.innerText = "비밀번호는 6자 이상이어야 합니다."; return; }
  if (password !== confirmPw) { msgEl.innerText = "비밀번호가 서로 일치하지 않습니다."; return; }

  msgEl.innerText = "CREATING ACCOUNT...";
  const { error } = await sb.auth.signUp({ email, password });
  if (error) {
    msgEl.innerText = "ERROR : " + error.message;
  } else {
    document.getElementById("signin-email").value = email;
    document.getElementById("signup-password").value = "";
    document.getElementById("signup-password-confirm").value = "";
    setAuthMode("signin");
    msgEl.innerText = "계정이 생성되었습니다. 방금 입력한 이메일과 비밀번호로 로그인해 주세요.";
  }
}

async function handleSignIn() {
  const email = document.getElementById("signin-email").value.trim();
  const password = document.getElementById("signin-password").value;
  const msgEl = document.getElementById("auth-msg");
  if (!email || !password) { msgEl.innerText = "이메일과 비밀번호를 입력하세요."; return; }

  msgEl.innerText = "SIGNING IN...";
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    msgEl.innerText = "ERROR : " + error.message;
  } else {
    msgEl.innerText = "";
    await updateAuthUI(data.user);
    loadArchives();
    loadGuestbook();
  }
}

async function handleSignOut() {
  await sb.auth.signOut();
  await updateAuthUI(null);
  loadArchives();
  loadGuestbook();
  switchTab("anatomy");
}

// =========================================================
// 4. ARCHIVE (CREATE, READ, ADMIN EDIT & DELETE)
// =========================================================
async function loadArchives() {
  const listEl = document.getElementById("archive-list");
  const { data, error } = await sb
    .from("archives")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    listEl.innerHTML = `<p style="font-size:0.84rem; color:var(--muted);">ARCHIVE LOAD ERROR : ${escapeHtml(error.message)}</p>`;
    return;
  }
  cachedArchives = data || [];
  if (cachedArchives.length === 0) {
    listEl.innerHTML = `<p style="font-size:0.84rem; color:var(--muted);">등록된 아카이브 게시물이 없습니다.</p>`;
    return;
  }

  const isAdmin = currentUser && currentUser.email === ADMIN_EMAIL;

  listEl.innerHTML = cachedArchives.map(item => `
    <article class="archive-card">
      ${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.title)}" />` : ""}
      <div class="archive-body">
        <div class="archive-meta-row">
          <span class="archive-meta">${new Date(item.created_at).toLocaleDateString("ko-KR")}</span>
          ${isAdmin ? `
            <div class="archive-admin-actions">
              <button class="btn-sm" onclick="openArchiveEditModal(${item.id})">EDIT</button>
              <button class="btn-sm" onclick="deleteArchive(${item.id})">DELETE</button>
            </div>
          ` : ""}
        </div>
        <div class="archive-title">${escapeHtml(item.title)}</div>
        <div class="archive-desc">${escapeHtml(item.description || "")}</div>
      </div>
    </article>
  `).join("");
}

async function publishArchive() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const title = document.getElementById("arc-title").value.trim();
  const description = document.getElementById("arc-desc").value.trim();
  const fileInput = document.getElementById("arc-file");
  const statusEl = document.getElementById("arc-status");

  if (!title) { statusEl.innerText = "제목을 입력하세요."; return; }

  statusEl.innerText = "PUBLISHING...";
  let imageUrl = "";

  if (fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error: upErr } = await sb.storage.from("archive-images").upload(fileName, file);
    if (upErr) {
      statusEl.innerText = "IMAGE UPLOAD ERROR : " + upErr.message;
      return;
    }
    const { data: pubData } = sb.storage.from("archive-images").getPublicUrl(fileName);
    imageUrl = pubData.publicUrl;
  }

  const { error } = await sb.from("archives").insert({ title, description, image_url: imageUrl });
  if (error) {
    statusEl.innerText = "PUBLISH ERROR : " + error.message;
  } else {
    statusEl.innerText = "PUBLISHED.";
    document.getElementById("arc-title").value = "";
    document.getElementById("arc-desc").value = "";
    fileInput.value = "";
    loadArchives();
  }
}

function openArchiveEditModal(id) {
  const item = cachedArchives.find(a => a.id === id);
  if (!item) return;
  document.getElementById("edit-arc-id").value = item.id;
  document.getElementById("edit-arc-old-url").value = item.image_url || "";
  document.getElementById("edit-arc-title").value = item.title || "";
  document.getElementById("edit-arc-desc").value = item.description || "";
  document.getElementById("edit-arc-file").value = "";
  document.getElementById("edit-arc-status").innerText = "";
  document.getElementById("archive-edit-modal").classList.add("open");
}

function closeArchiveEditModal() {
  document.getElementById("archive-edit-modal").classList.remove("open");
}

async function submitArchiveEdit() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  const id = Number(document.getElementById("edit-arc-id").value);
  const oldUrl = document.getElementById("edit-arc-old-url").value;
  const title = document.getElementById("edit-arc-title").value.trim();
  const description = document.getElementById("edit-arc-desc").value.trim();
  const fileInput = document.getElementById("edit-arc-file");
  const statusEl = document.getElementById("edit-arc-status");

  if (!title) { statusEl.innerText = "제목을 입력하세요."; return; }
  statusEl.innerText = "SAVING...";

  let imageUrl = oldUrl;
  if (fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error: upErr } = await sb.storage.from("archive-images").upload(fileName, file);
    if (upErr) {
      statusEl.innerText = "IMAGE UPLOAD ERROR : " + upErr.message;
      return;
    }
    const { data: pubData } = sb.storage.from("archive-images").getPublicUrl(fileName);
    imageUrl = pubData.publicUrl;

    if (oldUrl && oldUrl.includes("/archive-images/")) {
      const oldPath = oldUrl.split("/archive-images/").pop();
      if (oldPath) await sb.storage.from("archive-images").remove([oldPath]);
    }
  }

  const { error } = await sb
    .from("archives")
    .update({ title, description, image_url: imageUrl })
    .eq("id", id);

  if (error) {
    statusEl.innerText = "UPDATE ERROR : " + error.message;
  } else {
    closeArchiveEditModal();
    loadArchives();
  }
}

async function deleteArchive(id) {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) return;
  if (!confirm("이 아카이브 게시물을 영구 삭제하시겠습니까?")) return;

  const item = cachedArchives.find(a => a.id === id);
  const { error } = await sb.from("archives").delete().eq("id", id);
  if (error) {
    alert("DELETE ERROR : " + error.message);
    return;
  }

  if (item && item.image_url && item.image_url.includes("/archive-images/")) {
    const filePath = item.image_url.split("/archive-images/").pop();
    if (filePath) await sb.storage.from("archive-images").remove([filePath]);
  }
  loadArchives();
}

// =========================================================
// 5. GUESTBOOK (COOLDOWN + HONEYPOT + RETROACTIVE BADGES)
// =========================================================
function startCooldownTimer(secondsRemaining) {
  const btn = document.getElementById("btn-post-gb");
  const statusEl = document.getElementById("gb-status");
  if (cooldownInterval) clearInterval(cooldownInterval);

  let left = Math.ceil(secondsRemaining);
  if (left <= 0) {
    btn.disabled = false;
    btn.innerText = "POST MESSAGE";
    return;
  }

  btn.disabled = true;
  btn.innerText = `COOLDOWN (${left}S)`;
  cooldownInterval = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(cooldownInterval);
      btn.disabled = false;
      btn.innerText = "POST MESSAGE";
      if (statusEl.innerText.includes("쿨다운")) statusEl.innerText = "";
    } else {
      btn.innerText = `COOLDOWN (${left}S)`;
    }
  }, 1000);
}

async function loadGuestbook() {
  const listEl = document.getElementById("gb-list");
  const { data, error } = await sb
    .from("guestbook")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    listEl.innerHTML = `<p style="font-size:0.84rem; color:var(--muted);">ERROR : ${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!data || data.length === 0) {
    listEl.innerHTML = `<p style="font-size:0.84rem; color:var(--muted);">첫 번째 방명록을 남겨보세요.</p>`;
    return;
  }

  const isAdmin = currentUser && currentUser.email === ADMIN_EMAIL;

  if (currentUser) {
    const myLatest = data.find(r => r.user_id === currentUser.id);
    if (myLatest) {
      const elapsedSec = (Date.now() - new Date(myLatest.created_at).getTime()) / 1000;
      if (elapsedSec < 60) {
        startCooldownTimer(60 - elapsedSec);
      }
    }
  }

  listEl.innerHTML = data.map(row => {
    const displayName = row.author_name && row.author_name.trim()
      ? row.author_name.trim()
      : row.author_email.split("@")[0];
    const isOwner = currentUser && currentUser.id === row.user_id;
    const canDelete = isAdmin || isOwner;

    let badgeText = row.badge_label ? row.badge_label.trim() : "";
    if (isOwner && currentUserProfile) {
      badgeText = getActiveBadgeLabelForPost() || "";
    }
    const isArch = badgeText === "ARCHITECT";

    return `
      <div class="gb-item">
        <div class="gb-head">
          <span class="gb-author">
            <strong>${escapeHtml(displayName)}</strong>
            ${badgeText ? `<span class="user-badge-tag ${isArch ? "architect" : ""}">[${escapeHtml(badgeText)}]</span>` : ""}
            <span style="margin-left:6px;">(${escapeHtml(row.author_email)})</span>
          </span>
          <div class="gb-actions">
            <span>${new Date(row.created_at).toLocaleString("ko-KR")}</span>
            ${canDelete ? `<button class="btn-sm" onclick="deleteGuestbook(${row.id})">DELETE</button>` : ""}
          </div>
        </div>
        <div class="gb-msg">${escapeHtml(row.message)}</div>
      </div>
    `;
  }).join("");
}

async function postGuestbook() {
  const statusEl = document.getElementById("gb-status");
  const nameEl = document.getElementById("gb-name");
  const inputEl = document.getElementById("gb-input");
  const hpVal = document.getElementById("gb-website-hp").value;

  if (hpVal) return;

  const authorName = nameEl.value.trim();
  const message = inputEl.value.trim();

  if (!currentUser) { statusEl.innerText = "먼저 상단에서 로그인해 주세요."; return; }
  if (!authorName) { statusEl.innerText = "방명록에 표시할 이름을 입력하세요."; nameEl.focus(); return; }
  if (!message) { statusEl.innerText = "메시지를 입력하세요."; inputEl.focus(); return; }

  statusEl.innerText = "POSTING...";
  localStorage.setItem("gb_display_name_" + currentUser.id, authorName);
  const badgeLabel = getActiveBadgeLabelForPost();

  const { error } = await sb.from("guestbook").insert({
    user_id: currentUser.id,
    author_email: currentUser.email,
    author_name: authorName,
    badge_label: badgeLabel,
    message
  });

  if (error) {
    if (error.message.includes("row-level security")) {
      statusEl.innerText = "스팸 방지를 위해 60초 쿨다운이 적용 중입니다. 잠시 후 다시 시도해 주세요.";
      startCooldownTimer(60);
    } else {
      statusEl.innerText = "ERROR : " + error.message;
    }
    return;
  }

  if (currentUserProfile) {
    const nextPosts = (currentUserProfile.post_count || 0) + 1;
    const unlocked = [...(currentUserProfile.unlocked_badges || ["guest", "chronicle"])].filter(c => c !== "scribe_5");
    if (nextPosts >= 1 && !unlocked.includes("scribe_1")) unlocked.push("scribe_1");

    currentUserProfile.post_count = nextPosts;
    currentUserProfile.unlocked_badges = unlocked;
    renderBadgePanel();

    await sb
      .from("user_profiles")
      .update({ post_count: nextPosts, unlocked_badges: unlocked, updated_at: new Date().toISOString() })
      .eq("user_id", currentUser.id);
  }

  statusEl.innerText = "";
  inputEl.value = "";
  startCooldownTimer(60);
  loadGuestbook();
}

async function deleteGuestbook(id) {
  if (!currentUser) return;
  if (!confirm("이 방명록 댓글을 삭제하시겠습니까?")) return;

  const statusEl = document.getElementById("gb-status");
  const { error } = await sb.from("guestbook").delete().eq("id", id);
  if (error) {
    statusEl.innerText = "DELETE ERROR : " + error.message;
  } else {
    statusEl.innerText = "";
    loadGuestbook();
  }
}

// =========================================================
// INITIALIZE ON LOAD
// =========================================================
window.addEventListener("DOMContentLoaded", async () => {
  initAnatomyEngine();
  const { data } = await sb.auth.getSession();
  await updateAuthUI(data?.session?.user || null);
  loadArchives();
  loadGuestbook();
});
