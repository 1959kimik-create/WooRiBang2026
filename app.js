(() => {
  "use strict";

  const rooms = ["A", "B", "C"];
  const notices = [
    {
      title: "우리방 사용 안내",
      date: "2026.10.06",
      summary: "예약부터 입장, 대화 저장까지 우리방의 기본 이용 방법을 안내합니다.",
      body: "우리방은 대화와 토론을 위한 온라인 공간입니다.\n\n예약한 방과 시간을 확인한 뒤 예약 암호를 입력해 입장해 주세요. 기본 이용 시간은 2시간이며, 다음 예약과 겹치지 않는 경우 10분 한 차례 연장할 수 있습니다.\n\n대화와 공유 자료는 회의 중 브라우저 메모리에만 임시 보관됩니다. 저장을 선택하면 자료를 내 PC로 내려받을 수 있으며, 방을 나가면 이 프로토타입의 임시 자료는 삭제됩니다."
    },
    {
      title: "안전하고 편안한 토론을 위해",
      date: "2026.10.01",
      summary: "서로의 의견을 존중하고 공유 자료의 권리를 확인해 주세요.",
      body: "모든 참여자가 편안하게 의견을 나눌 수 있도록 서로 존중하는 표현을 사용해 주세요.\n\n공유하는 파일과 링크는 토론에 필요한 자료인지 확인하고, 다른 사람의 개인정보나 권리가 포함된 자료는 주의해 주세요."
    },
    {
      title: "서비스 시연 버전 안내",
      date: "2026.09.25",
      summary: "현재 버전은 한 브라우저에서 기능을 확인하는 로컬 시연용입니다.",
      body: "현재 우리방은 서버 연결이 없는 로컬 프로토타입입니다. 예약, 참여자, 채팅과 공유 자료는 현재 브라우저 탭에서만 동작하며 다른 PC와 실시간으로 공유되지 않습니다.\n\n음성 입력은 지원 브라우저의 음성 인식 기능을 사용합니다. 실제 음성 통화, 계정, 다중 사용자 예약 동기화 기능은 서버 구현 단계에서 추가해야 합니다."
    }
  ];

  const state = {
    page: "home",
    selectedRoom: "A",
    selectedDate: dateKey(new Date()),
    selectedSlot: null,
    bookings: [],
    activeBookingId: null,
    lastCreatedBookingId: null,
    pendingCleanupId: null,
    backendReady: false,
    backendStatus: window.roomBackend?.available ? "connecting" : "local",
    userId: null,
    messages: [],
    sharedItems: [],
    activeShareIndex: 0,
    shareZoom: 1,
    localMediaStream: null,
    cameraEnabled: false,
    microphoneEnabled: false,
    roomChannel: null,
    presenceParticipants: [],
    peerConnections: new Map(),
    remoteStreams: new Map(),
    remoteAudioBlocked: false,
    microphoneRecoveryPromise: null,
    currentName: "",
    language: "ko",
    noticeIndex: 0,
    toastTimer: null,
    recognition: null,
    recognitionRestartTimer: null,
    recognitionRetryCount: 0,
    recognitionNetworkNoticeShown: false,
    recognitionStatus: "off",
    tickTimer: null,
    lastScheduleRefreshAt: 0,
    unsubscribeRoom: null
  };

  const app = document.querySelector("#app");
  const modalRoot = document.querySelector("#modal-root");
  const backend = window.roomBackend;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function dateFromKey(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  function localDateTime(date, minutes) {
    const value = dateFromKey(date);
    value.setMinutes(minutes);
    return value;
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric", month: "long", day: "numeric", weekday: "short"
    }).format(date);
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date);
  }

  function formatFull(date) {
    const d = new Intl.DateTimeFormat("ko-KR", {
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(date).replace(/\s/g, "");
    return `${d} ${formatTime(date)}`;
  }

  function formatKoreanDateTime(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}년 ${pad(date.getMonth() + 1)}월 ${pad(date.getDate())}일 ${pad(date.getHours())}시 ${pad(date.getMinutes())}분`;
  }

  function activeBooking() {
    return state.bookings.find((booking) => booking.id === state.activeBookingId) || null;
  }

  function normalizeBooking(row) {
    return {
      id: row.reservation_id || row.id,
      room: row.room_id || row.room,
      start: new Date(row.starts_at || row.start).getTime(),
      end: new Date(row.ends_at || row.end).getTime(),
      extended: Boolean(row.extended),
      status: row.status
    };
  }

  async function refreshSchedule(date = state.selectedDate, dayCount = 1) {
    if (!state.backendReady) return;
    const from = dateFromKey(date);
    const until = new Date(from);
    until.setDate(until.getDate() + dayCount);
    try {
      const rows = await backend.schedule(from, until);
      const relevant = rows.map(normalizeBooking);
      const otherDates = state.bookings.filter((booking) =>
        booking.end <= from.getTime() || booking.start >= until.getTime()
      );
      state.bookings = [...otherDates, ...relevant];
      state.lastScheduleRefreshAt = Date.now();
    } catch (error) {
      console.error("Could not load room schedule.", error);
      toast("예약 현황을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.", true);
    }
  }

  async function refreshRoomBookings(roomId = state.selectedRoom) {
    if (!state.backendReady) return;
    try {
      const rows = await backend.bookings(roomId);
      const otherRooms = state.bookings.filter((booking) => booking.room !== roomId);
      state.bookings = [...otherRooms, ...rows.map(normalizeBooking)];
      state.lastScheduleRefreshAt = Date.now();
    } catch (error) {
      console.error("Could not load room reservations.", error);
      toast("해당 방의 예약을 불러오지 못했습니다.", true);
    }
  }

  async function refreshMeetingData(change = "all") {
    const booking = activeBooking();
    if (!state.backendReady || !booking) return;
    try {
      if (change === "all" || change === "messages") {
        const rows = await backend.messages(booking.id);
        state.messages = rows.map((row) => ({
          name: row.sender_name,
          text: row.body,
          time: new Date(row.created_at).getTime(),
          mine: row.sender_id === state.userId,
          voice: row.input_type === "voice"
        }));
      }
      if (change === "all" || change === "shared") {
        const currentShareId = state.sharedItems[state.activeShareIndex]?.id;
        const rows = await backend.sharedFiles(booking.id);
        const next = [];
        for (const row of rows) {
          if (row.external_url) {
            next.push({ id: row.id, kind: "link", name: row.original_name, url: row.external_url });
          } else if (row.storage_path) {
            const file = await backend.downloadSharedFile(row.storage_path);
            next.push({ id: row.id, kind: "file", name: row.original_name, file, storagePath: row.storage_path });
          }
        }
        state.sharedItems = next;
        const visibleIndex = currentShareId ? next.findIndex((item) => item.id === currentShareId) : -1;
        state.activeShareIndex = visibleIndex >= 0 ? visibleIndex : Math.max(0, next.length - 1);
      }
      if (change === "all" || change === "reservation") {
        const rows = await backend.reservationForEntry(booking.id);
        if (!rows) {
          toast("토론방 예약이 종료되었습니다.", true);
          await leaveMeeting(false, true);
          return;
        }
        Object.assign(booking, normalizeBooking(rows));
      }
      if (state.page === "meeting") renderMeeting();
    } catch (error) {
      console.error("Could not refresh live room data.", error);
      toast("실시간 방 정보를 갱신하지 못했습니다.", true);
    }
  }

  async function initializeBackend() {
    if (!backend?.available) {
      state.backendStatus = "local";
      return;
    }
    try {
      await backend.checkConnection();
      state.backendReady = true;
      state.backendStatus = "connected";
      const inviteId = new URLSearchParams(location.search).get("reservation");
      if (inviteId) {
        const inviteBooking = await backend.reservationForEntry(inviteId);
        if (!inviteBooking) {
          state.page = "home";
          state.activeBookingId = null;
          render();
          return toast("초대 링크의 예약을 찾을 수 없거나 이용 시간이 종료되었습니다.", true);
        }
        state.activeBookingId = inviteId;
        state.selectedRoom = inviteBooking.room_id;
        state.bookings = [normalizeBooking(inviteBooking)];
      } else {
        await refreshSchedule(state.selectedDate, 30);
      }
      render();
    } catch (error) {
      state.backendReady = false;
      state.backendStatus = "error";
      console.error("Supabase initialization failed.", error);
      toast("Supabase 연결에 실패했습니다. 공개 키, 익명 로그인 설정, SQL 적용 상태를 확인해 주세요.", true);
      render();
    }
  }

  function header() {
    const connection = state.backendStatus === "connected"
      ? "온라인 연결됨"
      : state.backendStatus === "connecting"
        ? "온라인 연결 중"
        : state.backendStatus === "error"
          ? "온라인 연결 오류"
          : "로컬 시연";
    return `<header class="topbar">
      <button class="brand" data-action="home" aria-label="우리방 초기 화면">WOO RI BANG</button>
      <span class="topbar-note">${connection} · 좋은 대화가 머무는 곳</span>
    </header>`;
  }

  function renderHome() {
    const now = Date.now();
    const roomRows = rooms.map((room) => {
      const next = state.bookings
        .filter((booking) => booking.room === room && booking.end > now)
        .sort((a, b) => a.start - b.start)[0];
      const status = next && next.start <= now ? "진행 중" : next ? `다음 예약 ${formatTime(new Date(next.start))}` : "예약 가능";
      return `<button class="room-quick" data-action="room" data-room="${room}">
        <strong><span class="status-dot ${next ? "busy" : ""}"></span>${room} 토론방</strong>
        <span>${escapeHtml(status)}　→</span>
      </button>`;
    }).join("");

    app.innerHTML = `<main class="page">
      ${header()}
      <section class="home-hero">
        <div class="hero-art" aria-label="칠판 앞에서 둥근 테이블에 둘러앉아 대화하는 사람들">
          <button class="button secondary small-button notice-pill" data-action="notices">공지사항</button>
          <span class="art-person one" aria-hidden="true"></span>
          <span class="art-person two" aria-hidden="true"></span>
          <span class="art-person three" aria-hidden="true"></span>
          <div class="art-caption"><h2>생각을 나누고,<br>함께 답을 찾는 시간</h2><p>우리의 이야기가 시작되는 곳</p></div>
        </div>
        <div class="home-panel">
          <span class="eyebrow">A room for conversation</span>
          <h1>우리들의<br><span>토론방</span></h1>
          <p>함께 이야기 나눌 방을 예약하거나, 예약된 방으로 바로 이동해 보세요.</p>
          <button class="button" data-action="booking">예약하기 <span aria-hidden="true">↗</span></button>
          ${state.pendingCleanupId ? `<p role="alert" class="limit-note">회의는 종료됐지만 서버 자료 정리가 대기 중입니다. <button class="button secondary small-button" data-action="retry-cleanup">정리 재시도</button></p>` : ""}
          <div class="room-quick-list"><h3>방 바로가기</h3>${roomRows}</div>
          <p class="footer-note">기본 이용 2시간 · 10분 연장 1회 가능<br>${state.backendStatus === "connected" ? "예약과 대화가 Supabase를 통해 실시간 동기화됩니다." : "온라인 연결 전에는 이 브라우저에서만 동작하는 시연용입니다."}</p>
        </div>
      </section>
    </main>`;
  }

  function slotsForDate(date) {
    const firstMinute = date === dateKey(new Date()) ? new Date().getHours() * 60 : 0;
    const slotCount = (24 * 60 - firstMinute) / 30;
    return Array.from({ length: slotCount }, (_, index) => firstMinute + index * 30);
  }

  function bookingAt(room, start, end) {
    return state.bookings.find((booking) =>
      booking.room === room && booking.end > Date.now() &&
      booking.start < end && booking.end > start
    );
  }

  function renderSchedule() {
    const selectedDate = state.selectedDate;
    const currentDate = dateFromKey(selectedDate);
    const slotHeaders = slotsForDate(selectedDate).map((minutes) =>
      `<th scope="col">${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}</th>`
    ).join("");

    const body = rooms.map((room) => {
      const cells = slotsForDate(selectedDate).map((minutes) => {
        const start = localDateTime(selectedDate, minutes);
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        const booking = bookingAt(room, start.getTime(), end.getTime());
        const past = start.getTime() <= Date.now();
        const selected = state.selectedSlot && state.selectedSlot.room === room &&
          state.selectedSlot.minutes === minutes && state.selectedSlot.date === selectedDate;
        let classes = "slot";
        let text = "";
        let disabled = false;
        if (booking) {
          classes += " reserved";
          text = "예약됨";
          disabled = true;
        } else if (past) {
          classes += " past";
          disabled = true;
        } else if (selected) {
          classes += " selected";
          text = "선택";
        }
        return `<td><button class="${classes}" data-action="select-slot" data-room="${room}" data-minutes="${minutes}" aria-label="${room}방 ${String(Math.floor(minutes / 60)).padStart(2, "0")}시 ${minutes % 60 ? "30" : "00"}분 ${booking ? "예약됨" : selected ? "선택됨" : past ? "예약 불가" : "예약 가능"}" ${disabled ? "disabled" : ""}>${text}</button></td>`;
      }).join("");
      return `<tr><td>${room} 방</td>${cells}</tr>`;
    }).join("");

    return `<div class="schedule-scroll" tabindex="0" aria-label="예약 시간표 가로 스크롤">
      <table class="schedule"><thead><tr><th scope="col">방 / 시간</th>${slotHeaders}</tr></thead><tbody>${body}</tbody></table>
    </div>`;
  }

  function renderBooking() {
    const selection = state.selectedSlot;
    const currentDate = dateFromKey(state.selectedDate);
    const start = selection ? localDateTime(selection.date, selection.minutes) : null;
    const end = start ? new Date(start.getTime() + 2 * 60 * 60 * 1000) : null;
    const previousPasswordInput = document.querySelector("#reserve-password");
    const passwordDraft = previousPasswordInput?.value || "";
    const passwordHadFocus = document.activeElement === previousPasswordInput;
    const passwordSelection = passwordHadFocus
      ? [previousPasswordInput.selectionStart, previousPasswordInput.selectionEnd]
      : null;
    app.innerHTML = `<main class="page">
      ${header()}
      <div class="page-heading">
        <div><span class="eyebrow">Make a reservation</span><h2>토론방 예약하기</h2><p>방과 날짜를 고른 뒤, 초록색으로 선택 가능한 시작 시간을 눌러 주세요.</p></div>
        <button class="button secondary" data-action="home">초기 화면</button>
      </div>
      <section class="booking-layout">
        <div class="panel schedule-panel">
          <div class="schedule-tools">
            <div><strong>${escapeHtml(formatDate(currentDate))}</strong><p class="muted small" style="margin:5px 0 0">30분 단위 시작 · 기본 2시간 이용</p></div>
            <div class="date-control">
              <button class="button secondary small-button" data-action="date-step" data-step="-1" aria-label="하루 전">←</button>
              <input type="date" id="booking-date" aria-label="예약 날짜" value="${escapeHtml(state.selectedDate)}" min="${dateKey(new Date())}">
              <button class="button secondary small-button" data-action="date-step" data-step="1" aria-label="하루 뒤">→</button>
            </div>
          </div>
          ${renderSchedule()}
          <div class="legend" aria-label="시간표 범례">
            <span class="legend-item"><span class="legend-swatch"></span>예약 가능</span>
            <span class="legend-item"><span class="legend-swatch booked"></span>예약됨</span>
            <span class="legend-item"><span class="legend-swatch chosen"></span>선택한 시간</span>
          </div>
          <p class="footer-note">예약 시간은 현재 PC의 현지 시각을 사용합니다. 예약 가능 여부는 서버에서 최종 확인합니다.</p>
        </div>
        <aside class="panel booking-summary">
          <span class="eyebrow">Reservation details</span><h3 style="margin-top:9px">예약 정보</h3>
          <div class="summary-card">${start
            ? `<strong>${selection.room} 토론방</strong><p>${escapeHtml(formatFull(start))} 시작<br>${escapeHtml(formatTime(end))} 종료 예정<br>기본 이용 시간 2시간</p>`
            : `<strong>시간을 선택해 주세요</strong><p>예약 가능한 칸을 누르면 날짜와 이용 시간이 표시됩니다.</p>`}</div>
          <div class="field"><label for="reserve-password">입실 암호</label><input id="reserve-password" type="password" minlength="4" maxlength="64" autocomplete="off" placeholder="4자 이상 입력"></div>
          <p class="field-hint">참석자를 미리 등록할 필요는 없습니다. 입실할 때 대화에 사용할 이름을 입력합니다.</p>
          <p class="limit-note">예약 암호는 서버에 해시로 저장되며 확인 후 화면에서 지워집니다. 기본 2시간 이용 후, 다음 예약과 겹치지 않으면 10분 한 차례 연장할 수 있습니다.</p>
          <div class="form-actions"><button class="button full" data-action="confirm-reservation" ${selection ? "" : "disabled"}>예약 확인</button></div>
          <button class="button ghost full" data-action="home" style="margin-top:6px">취소</button>
        </aside>
      </section>
    </main>`;
    const passwordInput = document.querySelector("#reserve-password");
    passwordInput.value = passwordDraft;
    if (passwordHadFocus && passwordSelection) {
      passwordInput.focus();
      passwordInput.setSelectionRange(...passwordSelection);
    }
  }

  function renderRoomInfo() {
    const now = Date.now();
    const list = state.bookings
      .filter((booking) => booking.room === state.selectedRoom && booking.end > now)
      .sort((a, b) => a.start - b.start);
    const items = list.length ? list.map((booking) => {
      const canJoin = now >= booking.start && now < booking.end;
      return `<article class="booking-item">
        <div><strong>${escapeHtml(formatFull(new Date(booking.start)))}</strong><p>${escapeHtml(formatTime(new Date(booking.start)))}–${escapeHtml(formatTime(new Date(booking.end)))} · ${canJoin ? "진행 중" : "예약 완료"}</p></div>
        <button class="button ${canJoin ? "" : "secondary"} small-button" data-action="enter-booking" data-id="${escapeHtml(booking.id)}" ${canJoin ? "" : "disabled"}>${canJoin ? "입실하기" : "예약 시간 전"}</button>
      </article>`;
    }).join("") : `<div class="summary-card"><strong>현재 참여 가능한 예약이 없습니다</strong><p>예약 시간에 다시 방문하거나 이 방을 예약해 주세요.</p></div>`;

    app.innerHTML = `<main class="page">
      ${header()}
      <div class="page-heading"><div><span class="eyebrow">Room ${state.selectedRoom}</span><h2>${state.selectedRoom} 토론방</h2><p>예약 시작 시각이 되면 입실 암호를 입력해 참여할 수 있습니다.</p></div>
        <button class="button secondary" data-action="home">초기 화면</button></div>
      <section class="room-info-grid">
        <div class="panel"><h3>예약된 시간</h3><p class="muted small">${state.backendReady ? "모든 참여자의 예약 현황입니다." : "이 브라우저에서 만들어진 예약만 표시됩니다."}</p><div class="booking-list">${items}</div>
          <div class="form-actions"><button class="button" data-action="booking">이 방 예약하기</button><button class="button secondary" data-action="home">돌아가기</button></div>
        </div>
        <aside class="room-illustration">
          <img src="meeting_1.jpg" alt="테이블에 둘러앉아 대화하는 세 명의 참가자">
          <p>서로의 생각에 귀 기울이는 공간</p>
        </aside>
      </section>
    </main>`;
  }

  function renderNotices() {
    app.innerHTML = `<main class="page">
      ${header()}
      <div class="page-heading"><div><span class="eyebrow">Notice</span><h2>공지사항</h2><p>우리방 이용 소식과 안내를 최신 순으로 확인하세요.</p></div><button class="button secondary" data-action="home">나가기</button></div>
      <section class="notice-list">${notices.map((notice, index) => `<button class="notice-row" data-action="notice-detail" data-index="${index}">
        <strong>${escapeHtml(notice.title)}</strong><time>${escapeHtml(notice.date)}</time><p>${escapeHtml(notice.summary)}</p>
      </button>`).join("")}</section>
    </main>`;
  }

  function renderNoticeDetail() {
    const notice = notices[state.noticeIndex];
    app.innerHTML = `<main class="page">
      ${header()}
      <div class="page-heading"><div><span class="eyebrow">Notice detail</span><h2>${escapeHtml(notice.title)}</h2><p>${escapeHtml(notice.date)}</p></div><button class="button secondary" data-action="notices">목록으로</button></div>
      <section class="panel"><p class="muted">${escapeHtml(notice.summary)}</p><div class="notice-body">${escapeHtml(notice.body)}</div><button class="button secondary" data-action="notices">나가기</button></section>
    </main>`;
  }

  function renderEntry() {
    const booking = activeBooking();
    if (!booking) {
      state.page = "home";
      render();
      toast("예약 정보를 찾을 수 없습니다. 시연 예약은 새로고침 후 유지되지 않습니다.", true);
      return;
    }
    const remaining = booking.start - Date.now();
    const waiting = remaining > 0;
    const keypadKeys = [
      ["1", 27.9, 23.9], ["2", 51.2, 23.9], ["3", 74.8, 23.9],
      ["4", 27.9, 33.8], ["5", 51.2, 33.8], ["6", 74.8, 33.8],
      ["7", 27.9, 43.7], ["8", 51.2, 43.7], ["9", 74.8, 43.7],
      ["*", 27.9, 53.4], ["0", 51.2, 53.4], ["#", 74.8, 53.4]
    ];
    app.innerHTML = `<main class="page">
      ${header()}
      <div class="page-heading"><div><span class="eyebrow">Room entry</span><h2>${booking.room} 토론방 입실</h2><p>${escapeHtml(formatFull(new Date(booking.start)))} 시작 · ${escapeHtml(formatTime(new Date(booking.end)))} 종료 예정</p></div><button class="button secondary" data-action="room" data-room="${booking.room}">돌아가기</button></div>
      <section class="panel entry-panel">
        <div class="summary-card"><strong id="entry-state">${waiting ? "아직 입실 시간이 아닙니다" : "예약 시간이 되었습니다"}</strong><p id="entry-countdown">${waiting ? `예약 시작까지 ${escapeHtml(countdown(remaining))} 남았습니다. 예약 전에 입실할 수 없습니다.` : "예약 암호를 입력해 토론방에 참여하세요."}</p></div>
        <div class="field"><label for="participant-name">참가자 이름</label><input id="participant-name" maxlength="40" value="${escapeHtml(state.currentName)}" placeholder="대화에서 사용할 이름" autocomplete="name"></div>
        <div class="field"><label for="entry-password">입실 암호</label><input id="entry-password" name="room-access-code" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="예약 암호 입력" aria-describedby="keypad-hint" ${waiting ? "disabled" : ""}>
          <p id="keypad-hint" class="field-hint">아래 숫자판을 클릭하거나 키보드로 예약 암호를 입력하세요.</p>
        </div>
        <div class="keypad-device">
          <img src="door_number.jpg" alt="1부터 9, 별표, 0, 우물정 표시가 있는 숫자판">
          ${keypadKeys.map(([key, x, y]) => `<button class="keypad-key" type="button" style="--key-x:${x}%;--key-y:${y}%" data-action="entry-key" data-key="${escapeHtml(key)}" aria-label="${escapeHtml(key)} 입력" aria-controls="entry-password" ${waiting ? "disabled" : ""}></button>`).join("")}
          <button class="keypad-key keypad-lock" type="button" data-action="submit-entry" aria-label="입실하기" ${waiting ? "disabled" : ""}></button>
        </div>
        <p id="entry-error" class="small" role="alert" style="color:var(--red);min-height:20px"></p>
        <button class="button full" data-action="submit-entry" ${waiting ? "disabled" : ""}>입실하기</button>
      </section>
    </main>`;
  }

  function countdown(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours) return `${hours}시간 ${minutes}분`;
    return `${minutes}분 ${rest}초`;
  }

  function renderMessage(message) {
    const time = new Date(message.time);
    const body = String(message.text).split("\n").map((line, index) =>
      `${index ? " ".repeat(String(message.name).length + 2) : ""}${escapeHtml(line)}`
    ).join("<br>");
    return `<div class="chat-message ${message.system ? "system" : message.mine ? "mine" : ""}">
      <div class="message-bubble">${message.system ? "" : `<span class="message-speaker">${escapeHtml(message.name)}:</span> `}${body}</div>
      ${message.system ? "" : `<time class="message-time">${escapeHtml(formatTime(time))}${message.voice ? " · 음성" : ""}</time>`}
    </div>`;
  }

  function renderSharedItem(item) {
    if (item.kind === "link") {
      const videoUrl = sharedVideoUrl(item.url);
      if (videoUrl?.kind === "file") {
        return `<video class="shared-video" src="${escapeHtml(videoUrl.url)}" controls playsinline aria-label="${escapeHtml(item.name)}"></video>`;
      }
      if (videoUrl?.kind === "embed") {
        const playerUrl = new URL(videoUrl.url);
        const hasWebOrigin = location.origin !== "null";
        if (hasWebOrigin && videoUrl.provider === "youtube") {
          playerUrl.searchParams.set("enablejsapi", "1");
          playerUrl.searchParams.set("origin", location.origin);
        }
        const originNotice = hasWebOrigin
          ? ""
          : `<p class="field-hint">현재 파일로 직접 실행 중이라 동영상 사이트가 재생을 차단할 수 있습니다. HTTP/HTTPS 웹 주소로 접속해 주세요.</p>`;
        const player = hasWebOrigin
          ? `<iframe class="shared-video-embed" src="${escapeHtml(playerUrl.href)}" title="${escapeHtml(item.name)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`
          : `<div class="file-card"><p class="muted">동영상 링크는 HTTP/HTTPS 웹 주소로 접속했을 때 공유 화면에서 재생할 수 있습니다.</p></div>`;
        return `<div class="video-share">${player}<div class="video-share-fallback">${originNotice}<a class="button secondary small-button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">YouTube/Vimeo에서 열기</a></div></div>`;
      }
      return `<div class="file-card"><div class="share-icon" aria-hidden="true">↗</div><h3><a class="shared-link-title" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name)}</a></h3><p class="muted small">외부 링크 · 링크 대상 파일은 별도로 저장되지 않습니다.</p><a class="button small-button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">새 탭에서 열기</a></div>`;
    }
    const url = sharedFileUrl(item);
    const type = item.file.type;
    if (type.startsWith("image/")) return `<img src="${url}" alt="${escapeHtml(item.name)}">`;
    if (type.startsWith("video/") || ["mp4", "webm", "ogv", "m4v", "mov"].includes(fileExtension(item.name))) {
      return `<video src="${url}" controls playsinline aria-label="${escapeHtml(item.name)}"></video>`;
    }
    if (type === "application/pdf") return `<iframe src="${url}" title="${escapeHtml(item.name)}"></iframe>`;
    if (item.previewHtml) return `<div class="document-preview">${item.previewHtml}</div>`;
    if (item.previewError) {
      return `<div class="file-card"><div class="share-icon" aria-hidden="true">▤</div><h3>${escapeHtml(item.name)}</h3><p class="muted">문서 미리보기를 준비하지 못했습니다. 내려받아 확인해 주세요.</p><a class="button secondary small-button" href="${url}" download="${escapeHtml(item.name)}">파일 내려받기</a></div>`;
    }
    if (item.previewLoading) return `<div class="file-card"><p class="muted">문서 미리보기를 준비하고 있습니다…</p></div>`;
    const extension = fileExtension(item.name);
    if (["txt", "csv", "docx", "xls", "xlsx", "pptx"].includes(extension)) {
      return `<div class="file-card"><p class="muted">문서 미리보기를 준비하고 있습니다…</p></div>`;
    }
    if (["doc", "ppt"].includes(extension)) {
      return `<div class="file-card"><div class="share-icon" aria-hidden="true">▤</div><h3>${escapeHtml(item.name)}</h3><p class="muted">이 구형 Office 형식은 브라우저 미리보기를 지원하지 않습니다. 파일을 내려받아 확인해 주세요.</p><a class="button secondary small-button" href="${url}" download="${escapeHtml(item.name)}">파일 내려받기</a></div>`;
    }
    return `<div class="file-card"><div class="share-icon" aria-hidden="true">▤</div><h3>${escapeHtml(item.name)}</h3><p class="muted">자료가 공유되었습니다.</p><a class="button secondary small-button" href="${url}" download="${escapeHtml(item.name)}">파일 열기 / 내려받기</a></div>`;
  }

  function sharedFileUrl(item) {
    if (!item.objectUrl) item.objectUrl = URL.createObjectURL(item.file);
    return item.objectUrl;
  }

  function fileExtension(name) {
    return name.split(".").pop().toLowerCase();
  }

  function sharedVideoUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host)) {
      const videoId = host === "youtu.be"
        ? url.pathname.split("/").filter(Boolean)[0]
        : url.pathname === "/watch" ? url.searchParams.get("v")
          : url.pathname.split("/").filter(Boolean).slice(-1)[0];
      if (videoId && /^[\w-]{11}$/.test(videoId)) {
        return { kind: "embed", provider: "youtube", url: `https://www.youtube.com/embed/${videoId}` };
      }
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const videoId = url.pathname.split("/").filter(Boolean).find((part) => /^\d+$/.test(part));
      if (videoId) return { kind: "embed", provider: "vimeo", url: `https://player.vimeo.com/video/${videoId}` };
    }
    if (/\.(mp4|webm|ogv|m4v|mov)$/i.test(url.pathname)) {
      return { kind: "file", url: url.href };
    }
    return null;
  }

  function sanitizeDocumentHtml(value) {
    const document = new DOMParser().parseFromString(value, "text/html");
    const allowedTags = new Set(["A", "BLOCKQUOTE", "BR", "CODE", "EM", "H1", "H2", "H3", "H4", "LI", "OL", "P", "STRONG", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL"]);
    const cleanNode = (node) => {
      for (const child of Array.from(node.children)) {
        if (!allowedTags.has(child.tagName)) {
          child.replaceWith(document.createTextNode(child.textContent || ""));
          continue;
        }
        const href = child.tagName === "A" ? validHttpUrl(child.getAttribute("href") || "") : null;
        for (const attribute of Array.from(child.attributes)) child.removeAttribute(attribute.name);
        if (href) {
          child.setAttribute("href", href);
          child.setAttribute("target", "_blank");
          child.setAttribute("rel", "noopener noreferrer");
        }
        cleanNode(child);
      }
    };
    cleanNode(document.body);
    return document.body.innerHTML;
  }

  async function loadBrowserLibrary(src, globalName) {
    if (window[globalName]) return window[globalName];
    const existing = document.querySelector(`script[data-preview-library="${globalName}"]`);
    if (existing?.dataset.loaded === "true") return window[globalName];
    if (existing?.dataset.loading === "true") {
      await new Promise((resolve, reject) => {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
      });
      if (window[globalName]) return window[globalName];
      throw new Error(`Preview library ${globalName} did not initialize.`);
    }
    const script = existing || document.createElement("script");
    script.src = src;
    script.dataset.previewLibrary = globalName;
    script.dataset.loading = "true";
    const loaded = new Promise((resolve, reject) => {
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", reject, { once: true });
    });
    if (!existing) document.head.append(script);
    try {
      await loaded;
      script.dataset.loaded = "true";
      delete script.dataset.loading;
    } catch (error) {
      script.remove();
      throw error;
    }
    if (!window[globalName]) throw new Error(`Preview library ${globalName} did not initialize.`);
    return window[globalName];
  }

  async function makeDocumentPreview(item) {
    const extension = fileExtension(item.name);
    if (extension === "txt" || extension === "csv") {
      const text = await item.file.text();
      const clipped = text.length > 200000 ? `${text.slice(0, 200000)}\n\n[미리보기는 처음 200,000자까지만 표시합니다.]` : text;
      return `<pre>${escapeHtml(clipped)}</pre>`;
    }
    if (extension === "docx") {
      const mammoth = await loadBrowserLibrary(
        "https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js",
        "mammoth"
      );
      const result = await mammoth.convertToHtml({ arrayBuffer: await item.file.arrayBuffer() });
      if (result.messages.some((message) => message.type === "error")) {
        throw new Error(result.messages.map((message) => message.message).join(" "));
      }
      return sanitizeDocumentHtml(result.value);
    }
    if (extension === "xls" || extension === "xlsx") {
      const XLSX = await loadBrowserLibrary(
        "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
        "XLSX"
      );
      const workbook = XLSX.read(await item.file.arrayBuffer(), { type: "array" });
      return workbook.SheetNames.map((name) => {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false });
        const visibleRows = rows.slice(0, 200);
        const table = visibleRows.map((row) => `<tr>${row.slice(0, 20).map((cell) => `<td>${escapeHtml(cell ?? "")}</td>`).join("")}</tr>`).join("");
        const clipped = rows.length > 200 || rows.some((row) => row.length > 20);
        return `<section><h3>${escapeHtml(name)}</h3><div class="document-table-scroll"><table>${table}</table></div>${clipped ? '<p class="field-hint">미리보기는 시트당 최대 200행, 20열까지 표시합니다.</p>' : ""}</section>`;
      }).join("");
    }
    if (extension === "pptx") {
      const JSZip = await loadBrowserLibrary(
        "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
        "JSZip"
      );
      const archive = await JSZip.loadAsync(await item.file.arrayBuffer());
      const slidePaths = Object.keys(archive.files)
        .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
        .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
      if (!slidePaths.length) throw new Error("Presentation has no slides.");
      const slides = await Promise.all(slidePaths.map(async (path, index) => {
        const xml = new DOMParser().parseFromString(await archive.file(path).async("text"), "application/xml");
        const text = Array.from(xml.getElementsByTagName("a:p"), (paragraph) =>
          Array.from(paragraph.getElementsByTagName("a:t"), (node) => node.textContent || "").join("")
        ).filter(Boolean).join("\n");
        return `<section><h3>슬라이드 ${index + 1}</h3><pre>${escapeHtml(text || "(텍스트 없음)")}</pre></section>`;
      }));
      return slides.join("");
    }
    throw new Error(`Preview is not supported for .${extension} files.`);
  }

  function prepareDocumentPreview(item) {
    if (item.previewLoading || item.previewHtml || item.previewError) return;
    item.previewLoading = true;
    void makeDocumentPreview(item).then((html) => {
      item.previewHtml = html;
    }).catch((error) => {
      item.previewError = error;
      console.error("Could not prepare a shared document preview.", error);
    }).finally(() => {
      item.previewLoading = false;
      if (state.page === "meeting" && state.sharedItems[state.activeShareIndex] === item) renderMeeting();
    });
  }

  function clearObjectUrls() {
    for (const item of state.sharedItems) {
      if (item.objectUrl) {
        URL.revokeObjectURL(item.objectUrl);
        item.objectUrl = null;
      }
    }
  }

  function renderMeeting() {
    const previousChatLog = document.querySelector("#chat-log");
    const chatScrollTop = previousChatLog?.scrollTop || 0;
    const chatInput = document.querySelector("#chat-input");
    const preserveChatInput = document.activeElement === chatInput;
    const chatDraft = preserveChatInput ? chatInput.value : "";
    const chatSelection = preserveChatInput
      ? [chatInput.selectionStart, chatInput.selectionEnd, chatInput.selectionDirection]
      : null;
    const pageScroll = [window.scrollX, window.scrollY];
    const booking = activeBooking();
    if (!booking) {
      state.page = "home";
      render();
      return;
    }
    const messages = state.messages.map(renderMessage).join("");
    if (state.activeShareIndex >= state.sharedItems.length) state.activeShareIndex = state.sharedItems.length - 1;
    const activeShare = state.sharedItems[state.activeShareIndex];
    const shared = activeShare
      ? renderSharedItem(state.sharedItems[state.activeShareIndex])
      : `<div class="empty-share"><div class="share-icon" aria-hidden="true">＋</div><h3>공유 화면이 비어 있습니다</h3><p class="small">공유 파일 목록에서 함께 볼 자료를 선택하거나 PC 파일을 추가해 주세요.</p></div>`;
    if (activeShare?.kind === "file" &&
      ["txt", "csv", "docx", "xls", "xlsx", "pptx"].includes(fileExtension(activeShare.name))) {
      prepareDocumentPreview(activeShare);
    }
    const participants = meetingParticipants();
    const participantCards = participants.map((participant, index) => `<button class="participant-tile" data-action="participant-preview" data-index="${index}" aria-label="${escapeHtml(participant.name)} 참가자 영상 미리보기">
      ${participant.cameraEnabled && (participant.self ? state.localMediaStream : participant.stream)
        ? `<video class="participant-video" ${participant.self ? 'data-local-preview muted' : `data-remote-preview="${escapeHtml(participant.id)}" muted`} autoplay playsinline></video>`
        : `<span class="participant-avatar">${escapeHtml(participant.name.slice(0, 1))}</span>`}
      <strong>${escapeHtml(participant.name)}${participant.self ? " (나)" : ""}</strong>
      <span class="participant-status" aria-label="${participant.self ? "내 장치 상태" : participant.presence ? "상대 장치 상태" : "장치 상태 미연결"}">
        <span class="participant-device camera-status ${participant.presence ? (participant.cameraEnabled ? "is-on" : "is-off") : "is-unknown"}" title="${participant.presence ? `카메라 ${participant.cameraEnabled ? "ON" : "OFF"}` : "카메라 상태 미연결"}" aria-label="${participant.presence ? `카메라 ${participant.cameraEnabled ? "ON" : "OFF"}` : "카메라 상태 미연결"}">C</span>
        <span class="participant-device microphone-status ${participant.presence ? (participant.microphoneEnabled ? "is-on" : "is-off") : "is-unknown"}" title="${participant.presence ? `마이크 ${participant.microphoneEnabled ? "ON" : "OFF"}` : "마이크 상태 미연결"}" aria-label="${participant.presence ? `마이크 ${participant.microphoneEnabled ? "ON" : "OFF"}` : "마이크 상태 미연결"}">M</span>
      </span>
    </button>`).join("");
    const remoteAudio = participants
      .filter((participant) => !participant.self && participant.stream)
      .map((participant) => `<audio data-remote-audio="${escapeHtml(participant.id)}" autoplay></audio>`)
      .join("");
    app.innerHTML = `<main class="page meeting-page">
      <header class="meeting-topbar">
        <div class="meeting-title"><button class="brand" data-action="home" aria-label="우리방 초기 화면">WOO RI BANG</button><h1>${booking.room} 토론방</h1></div>
        <div class="meeting-time"><span>시작 ${escapeHtml(formatTime(new Date(booking.start)))}</span><span>종료 예정 ${escapeHtml(formatTime(new Date(booking.end)))}</span><span id="meeting-countdown"></span></div>
        <button class="button secondary meeting-extend" data-action="extend" ${booking.extended ? "disabled" : ""}>${booking.extended ? "연장 완료" : "10분 연장"}</button>
      </header>
      <section class="participant-strip" aria-label="참가자 카메라와 마이크 상태">
        <div class="participant-list">${participantCards || `<p class="muted small">참가자를 불러오는 중입니다.</p>`}</div>
        <div class="device-controls" aria-label="내 장치 상태">
          <button class="button device-toggle ${state.cameraEnabled ? "is-on" : "is-off"}" type="button" data-action="toggle-device" data-device="camera" aria-label="카메라 ${state.cameraEnabled ? "ON" : "OFF"}" aria-pressed="${state.cameraEnabled}" title="${state.cameraEnabled ? "카메라 켜짐" : "카메라 꺼짐"}">카메라</button>
          <button class="button device-toggle ${state.microphoneEnabled ? "is-on" : "is-off"}" type="button" data-action="toggle-device" data-device="microphone" aria-label="마이크 ${state.microphoneEnabled ? "ON" : "OFF"}" aria-pressed="${state.microphoneEnabled}" title="${state.microphoneEnabled ? "마이크 켜짐" : "마이크 꺼짐"}">마이크</button>
          ${state.remoteAudioBlocked ? `<button class="button secondary small-button" type="button" data-action="enable-remote-audio">상대 소리 재생</button>` : ""}
        </div>
      </section>
      ${remoteAudio}
      <section class="meeting-layout">
        <section class="panel share-column" aria-label="공유 화면">
          <div class="share-stage" id="share-stage"><div class="share-content" style="--share-zoom:${state.shareZoom}">${shared}</div></div>
          <div class="share-controls">
            <button class="button secondary small-button" data-action="shared-files">공유파일 목록</button>
            <div class="zoom-controls" aria-label="공유 화면 확대 축소">
              <button class="button secondary small-button" data-action="share-zoom" data-step="-1" aria-label="축소">−</button>
              <span id="share-zoom-value">${Math.round(state.shareZoom * 100)}%</span>
              <button class="button secondary small-button" data-action="share-zoom" data-step="1" aria-label="확대">＋</button>
            </div>
            <button class="button danger small-button" data-action="clear-share" aria-label="공유 화면 닫기">× 닫기</button>
          </div>
        </section>
        <section class="panel chat-column" aria-label="대화">
          <div class="chat-heading"><h2>대화</h2><label for="meeting-language">표시 언어</label>
            <select id="meeting-language" aria-describedby="language-status">
              <option value="ko" ${state.language === "ko" ? "selected" : ""}>한국어</option>
              <option value="en" ${state.language === "en" ? "selected" : ""}>English</option>
            </select>
          </div>
          <p id="language-status" class="field-hint">선택 언어: ${state.language === "ko" ? "한국어" : "English"} · 자동 번역은 다음 단계에서 연결됩니다.</p>
          <div class="chat-log" id="chat-log" aria-label="대화 내용" aria-live="polite">${messages}</div>
          <form class="chat-compose" id="chat-form">
            <label class="visually-hidden" for="chat-input">대화 내용</label>
            <textarea id="chat-input" maxlength="2000" rows="3" placeholder="대화 내용을 입력하세요" autocomplete="off"></textarea>
            <button class="button chat-send" type="submit">전송</button>
          </form>
          <div class="chat-footer">
            <div class="chat-file-controls">
              <button class="button secondary small-button" data-action="share-file">공유파일 선택</button>
            </div>
            <div class="meeting-actions">
              <button class="button secondary" data-action="save-exit">저장/종료</button>
              <button class="button danger" data-action="leave">종료</button>
            </div>
          </div>
          <p class="field-hint voice-notice" id="voice-status" data-status="${state.recognitionStatus}" role="status" aria-live="polite">${escapeHtml(voiceStatusMessage())}</p>
        </section>
      </section>
      <input class="visually-hidden" id="share-file-input" type="file" accept="image/*,video/*,application/pdf,text/plain,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.zip">
    </main>`;
    const nextChatInput = document.querySelector("#chat-input");
    if (preserveChatInput && nextChatInput) {
      nextChatInput.value = chatDraft;
      nextChatInput.focus({ preventScroll: true });
      nextChatInput.setSelectionRange(chatSelection[0], chatSelection[1], chatSelection[2]);
    }
    window.scrollTo(pageScroll[0], pageScroll[1]);
    attachMediaPreviews();
    if (remoteAudio) {
      for (const audio of document.querySelectorAll("[data-remote-audio]")) {
        const stream = state.remoteStreams.get(audio.dataset.remoteAudio);
        if (!stream) continue;
        if (audio.srcObject !== stream) audio.srcObject = stream;
        audio.muted = false;
        audio.volume = 1;
        void audio.play().then(() => {
          if (state.remoteAudioBlocked) {
            state.remoteAudioBlocked = false;
            if (state.page === "meeting") renderMeeting();
          }
        }).catch((error) => {
          if (error.name === "NotAllowedError") {
            if (!state.remoteAudioBlocked) {
              state.remoteAudioBlocked = true;
              if (state.page === "meeting") renderMeeting();
            }
          } else {
            console.error("Could not play a participant's audio.", error);
          }
        });
      }
    }
    const log = document.querySelector("#chat-log");
    if (log) log.scrollTop = chatScrollTop;
    updateMeetingClock();
  }

  function voiceStatusMessage() {
    if (!state.microphoneEnabled) return "마이크를 켜면 이 PC에서 사용 가능한 마이크를 자동으로 연결해 인식된 발언을 대화창에 게시합니다.";
    if (state.recognitionStatus === "listening") return "마이크 연결됨 · 음성 인식 중입니다.";
    if (state.recognitionStatus === "reconnecting") return "마이크 연결됨 · 브라우저 음성 인식 서비스를 다시 연결하고 있습니다.";
    if (state.recognitionStatus === "service-unavailable") return "마이크는 연결됐지만 음성 인식 서비스에 연결되지 않습니다. 인터넷 연결과 브라우저의 음성 인식 서비스 접근을 확인해 주세요.";
    if (state.recognitionStatus === "unavailable") return "통화 마이크는 켜져 있습니다. 자동 음성 입력은 사용할 수 없으니 대화창에 직접 입력해 주세요.";
    return "마이크 연결됨 · 음성 인식 서비스를 시작하고 있습니다.";
  }

  function updateVoiceStatus() {
    const status = document.querySelector("#voice-status");
    if (status) {
      status.textContent = voiceStatusMessage();
      status.dataset.status = state.recognitionStatus;
    }
  }

  async function acquireAvailableMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("이 브라우저에서 마이크를 사용할 수 없습니다. HTTPS 또는 localhost로 접속해 주세요.");
    }

    let inputs = [];
    if (navigator.mediaDevices.enumerateDevices) {
      try {
        inputs = (await navigator.mediaDevices.enumerateDevices())
          .filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default");
      } catch (error) {
        console.warn("Could not enumerate microphones before capture; trying the browser default.", error);
      }
    }

    let lastError;
    for (const input of inputs) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: input.deviceId } },
          video: false
        });
        if (stream.getAudioTracks().some((track) => track.readyState === "live")) return stream;
        for (const track of stream.getTracks()) track.stop();
        console.warn(`Microphone did not provide a live audio track (${input.label || "unnamed device"}).`);
      } catch (error) {
        if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") throw error;
        lastError = error;
        console.warn(`Could not open an available microphone (${input.label || "unnamed device"}).`, error);
      }
    }

    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (defaultError) {
      if (defaultError.name === "NotAllowedError" || defaultError.name === "PermissionDeniedError") throw defaultError;
      if (lastError) console.warn("No enumerated microphone opened; the browser default also failed.", lastError);
      throw defaultError;
    }
  }

  async function recoverUnavailableMicrophone(checkDefaultDevice = false) {
    if (!state.microphoneEnabled || state.microphoneRecoveryPromise) return state.microphoneRecoveryPromise;
    const currentTrack = state.localMediaStream?.getAudioTracks().find((track) => track.readyState === "live");
    if (currentTrack && !checkDefaultDevice) return;

    state.microphoneRecoveryPromise = (async () => {
      let nextTrack;
      let recognitionStopped = false;
      try {
        const stream = await acquireAvailableMicrophone();
        nextTrack = stream.getAudioTracks()[0];
        if (!nextTrack) throw new Error("사용 가능한 마이크에서 오디오를 가져오지 못했습니다.");
        if (!state.microphoneEnabled || state.page !== "meeting") {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        if (currentTrack && currentTrack.getSettings().deviceId === nextTrack.getSettings().deviceId) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        stopSpeechRecognition();
        recognitionStopped = true;
        if (!state.localMediaStream) state.localMediaStream = new MediaStream();
        for (const track of state.localMediaStream.getAudioTracks()) {
          state.localMediaStream.removeTrack(track);
          track.stop();
        }
        for (const track of stream.getAudioTracks()) {
          if (track !== nextTrack) track.stop();
        }
        state.localMediaStream.addTrack(nextTrack);
        watchMicrophoneTrack(nextTrack);
        startSpeechRecognitionSafely(nextTrack);
        await Promise.all([...state.peerConnections.values()].map((peer) => syncPeerMedia(peer)));
        await Promise.all([...state.peerConnections.values()].map((peer) => requestPeerNegotiation(peer)));
        toast("연결된 사용 가능 마이크로 자동 전환했습니다.");
      } catch (error) {
        console.error("Could not switch to another available microphone.", error);
        if (nextTrack?.readyState === "live" && !state.localMediaStream?.getTracks().includes(nextTrack)) nextTrack.stop();
        if (currentTrack?.readyState === "live") {
          if (recognitionStopped) {
            startSpeechRecognitionSafely(currentTrack);
          }
        } else {
          state.microphoneEnabled = false;
          state.recognitionStatus = "off";
          stopSpeechRecognition();
        }
        syncPresence();
        await Promise.all([...state.peerConnections.values()].map((peer) => syncPeerMedia(peer)))
          .catch((syncError) => console.error("Could not update the unavailable microphone track.", syncError));
        toast("사용 가능한 마이크로 자동 전환하지 못했습니다. 마이크 연결과 브라우저 권한을 확인해 주세요.", true);
      } finally {
        state.microphoneRecoveryPromise = null;
        if (state.page === "meeting") renderMeeting();
      }
    })();
    return state.microphoneRecoveryPromise;
  }

  function watchMicrophoneTrack(track) {
    track.addEventListener("ended", () => {
      if (state.microphoneEnabled && state.page === "meeting") void recoverUnavailableMicrophone();
    }, { once: true });
  }

  function openSharedFilesDialog() {
    const files = state.sharedItems.map((item, index) => `<div class="shared-file-row">
      <span class="shared-file-icon" aria-hidden="true">${item.kind === "link" ? "↗" : "▤"}</span>
      <span>${escapeHtml(item.name)}</span>
      <span class="shared-file-actions">
        <button class="button secondary small-button" data-modal-action="select-shared" data-index="${index}" ${state.activeShareIndex >= 0 ? "disabled" : ""}>${state.activeShareIndex === index ? "표시 중" : "열기"}</button>
        <button class="button danger small-button" data-modal-action="ask-delete-shared" data-id="${escapeHtml(item.id || "")}">삭제</button>
      </span>
    </div>`).join("");
    showModal(`<span class="eyebrow">Shared files</span><h2>공유 파일 목록</h2>
      <p>${state.activeShareIndex >= 0 ? "목록에서 파일을 열려면 먼저 공유 화면을 닫아 주세요. 파일은 각 항목의 삭제 버튼으로 제거할 수 있습니다." : "파일을 열거나 각 항목의 삭제 버튼으로 제거할 수 있습니다."}</p>
      <div class="shared-file-list">${files || `<p class="muted">아직 공유된 파일이 없습니다.</p>`}</div>
      <div class="modal-actions"><button class="button secondary" data-modal-action="cancel">닫기</button></div>`);
  }

  async function deleteSharedItem(index) {
    const item = state.sharedItems[index];
    if (!item) return;
    try {
      if (state.backendReady) {
        await backend.deleteSharedFile(activeBooking().id, item.id);
      }
      if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
      const currentItem = state.sharedItems[state.activeShareIndex];
      const currentIndex = state.sharedItems.findIndex((candidate) =>
        candidate === item || (item.id && candidate.id === item.id)
      );
      if (currentIndex >= 0) state.sharedItems.splice(currentIndex, 1);
      state.activeShareIndex = currentItem
        ? state.sharedItems.findIndex((candidate) =>
          candidate === currentItem || (currentItem.id && candidate.id === currentItem.id)
        )
        : -1;
      closeModal();
      renderMeeting();
      openSharedFilesDialog();
      toast("공유 파일을 삭제했습니다.");
    } catch (error) {
      console.error("Could not delete the shared file.", error);
      toast(`공유 파일을 삭제하지 못했습니다${error.message ? `: ${error.message}` : "."}`, true);
    }
  }

  function openParticipantPreview(index) {
    const participants = meetingParticipants();
    const participant = participants[index];
    const name = participant?.name;
    if (!name) return;
    showModal(`<button class="participant-preview-close" data-modal-action="cancel" aria-label="영상 미리보기 닫기">×</button>
      <div class="participant-preview">${participant.cameraEnabled && (participant.self ? state.localMediaStream : participant.stream)
        ? `<video class="participant-preview-video" ${participant.self ? 'data-local-preview' : `data-remote-preview="${escapeHtml(participant.id)}"`} muted autoplay playsinline></video>`
        : `<div class="participant-avatar large">${escapeHtml(name.slice(0, 1))}</div>`}<h2>${escapeHtml(name)}</h2>
      <p>${participant.cameraEnabled && (participant.self ? state.localMediaStream : participant.stream)
        ? participant.self ? "내 카메라 미리보기" : "상대 카메라 영상"
        : participant.cameraEnabled
          ? "영상 연결 중입니다."
          : participant.presence
            ? "카메라가 꺼져 있습니다."
            : "상대 참가자의 장치 상태를 확인할 수 없습니다."}</p></div>`);
    modalRoot.querySelector(".modal-card")?.classList.add("participant-preview-dialog");
    attachMediaPreviews();
  }

  function meetingParticipants() {
    if (!state.backendReady) {
      return [{
        id: "local",
        name: state.currentName || "나",
        self: true,
        presence: true,
        cameraEnabled: state.cameraEnabled,
        microphoneEnabled: state.microphoneEnabled,
        stream: state.localMediaStream
      }];
    }
    return state.presenceParticipants.map((status) => {
      const self = status.user_id === state.userId;
      return {
        id: status.user_id,
        name: status.display_name,
        self,
        presence: true,
        cameraEnabled: self ? state.cameraEnabled : Boolean(status.camera_enabled),
        microphoneEnabled: self ? state.microphoneEnabled : Boolean(status.microphone_enabled),
        stream: self ? state.localMediaStream : state.remoteStreams.get(status.user_id)
      };
    });
  }

  function attachMediaPreviews() {
    for (const video of document.querySelectorAll("[data-local-preview]")) {
      if (!state.localMediaStream) continue;
      if (video.srcObject !== state.localMediaStream) video.srcObject = state.localMediaStream;
      void video.play().catch((error) => {
        if (error.name === "AbortError") return;
        console.error("Could not start the local camera preview.", error);
      });
    }
    for (const video of document.querySelectorAll("[data-remote-preview]")) {
      const stream = state.remoteStreams.get(video.dataset.remotePreview);
      if (!stream) continue;
      if (video.srcObject !== stream) video.srcObject = stream;
      void video.play().catch((error) => {
        if (error.name === "AbortError") return;
        console.error("Could not start a participant camera video.", error);
      });
    }
  }

  function syncPresence() {
    if (!state.roomChannel || !state.userId) return;
    void state.roomChannel.updatePresence({
      display_name: state.currentName,
      camera_enabled: state.cameraEnabled,
      microphone_enabled: state.microphoneEnabled
    }).catch((error) => {
      console.error("Could not update room media status.", error);
      toast("카메라·마이크 상태를 참가자에게 전달하지 못했습니다.", true);
    });
  }

  async function syncPeerMedia(peer) {
    for (const { kind, sender } of peer.senders) {
      const enabled = kind === "video" ? state.cameraEnabled : state.microphoneEnabled;
      const track = enabled
        ? state.localMediaStream?.getTracks()
          .find((item) => item.kind === kind && item.readyState === "live") || null
        : null;
      if (sender.track !== track) await sender.replaceTrack(track);
    }
  }

  async function requestPeerNegotiation(peer) {
    if (state.userId.localeCompare(peer.userId) < 0) {
      peer.needsNegotiation = true;
      await sendPeerOffer(peer);
    } else {
      await state.roomChannel?.sendSignal(peer.userId, { renegotiate: true });
    }
  }

  async function sendPeerOffer(peer) {
    const connection = peer.connection;
    if (peer.negotiating) return;
    if (connection.signalingState !== "stable") {
      peer.needsNegotiation = true;
      return;
    }
    peer.negotiating = true;
    peer.needsNegotiation = false;
    try {
      await syncPeerMedia(peer);
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await state.roomChannel?.sendSignal(peer.userId, { description: connection.localDescription.toJSON() });
    } catch (error) {
      console.error(`Could not create a video connection for participant ${peer.userId}.`, error);
      toast("상대방과 영상 연결을 시작하지 못했습니다. 네트워크 연결을 확인해 주세요.", true);
    } finally {
      peer.negotiating = false;
      if (peer.needsNegotiation && connection.signalingState === "stable") {
        queueMicrotask(() => { void sendPeerOffer(peer); });
      }
    }
  }

  function createPeerConnection(userId) {
    const existing = state.peerConnections.get(userId);
    if (existing) return existing;
    if (typeof RTCPeerConnection === "undefined") {
      toast("이 브라우저는 실시간 영상 통화를 지원하지 않습니다.", true);
      return null;
    }
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    const peer = {
      userId,
      connection,
      senders: [
        { kind: "video", sender: connection.addTransceiver("video", { direction: "sendrecv" }).sender },
        { kind: "audio", sender: connection.addTransceiver("audio", { direction: "sendrecv" }).sender }
      ],
      pendingCandidates: [],
      negotiating: false,
      needsNegotiation: false
    };
    state.peerConnections.set(userId, peer);
    void syncPeerMedia(peer).catch((error) => {
      console.error(`Could not attach local media for participant ${userId}.`, error);
    });
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        void state.roomChannel?.sendSignal(userId, { candidate: event.candidate.toJSON() }).catch((error) => {
          console.error(`Could not send an ICE candidate to participant ${userId}.`, error);
        });
      }
    };
    connection.ontrack = (event) => {
      const stream = state.remoteStreams.get(userId) || new MediaStream();
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      if (event.track.kind === "audio") event.track.enabled = true;
      state.remoteStreams.set(userId, stream);
      event.track.addEventListener("ended", () => {
        if (state.page === "meeting") renderMeeting();
      }, { once: true });
      if (state.page === "meeting") renderMeeting();
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") {
        console.error(`Video connection failed for participant ${userId}.`);
        toast("상대방과 영상 연결이 끊겼습니다. 네트워크나 방화벽 설정을 확인해 주세요.", true);
      }
    };
    connection.onsignalingstatechange = () => {
      if (connection.signalingState === "stable" && peer.needsNegotiation) {
        queueMicrotask(() => { void sendPeerOffer(peer); });
      }
    };
    if (state.userId.localeCompare(userId) < 0) {
      connection.onnegotiationneeded = () => { void sendPeerOffer(peer); };
      void sendPeerOffer(peer);
    }
    return peer;
  }

  async function handlePeerSignal(userId, signal) {
    const peer = createPeerConnection(userId);
    if (!peer || !signal) return;
    const connection = peer.connection;
    try {
      if (signal.renegotiate) {
        if (state.userId.localeCompare(userId) < 0) {
          peer.needsNegotiation = true;
          await sendPeerOffer(peer);
        }
        return;
      }
      if (signal.candidate) {
        if (connection.remoteDescription) {
          await connection.addIceCandidate(signal.candidate);
        } else {
          peer.pendingCandidates.push(signal.candidate);
        }
        return;
      }
      if (!signal.description) return;
      await connection.setRemoteDescription(signal.description);
      for (const candidate of peer.pendingCandidates.splice(0)) {
        await connection.addIceCandidate(candidate);
      }
      if (signal.description.type === "offer") {
        await syncPeerMedia(peer);
        await connection.setLocalDescription(await connection.createAnswer());
        await state.roomChannel?.sendSignal(userId, { description: connection.localDescription.toJSON() });
      }
    } catch (error) {
      console.error(`Could not process a video signal from participant ${userId}.`, error);
      toast("상대방의 영상 연결 정보를 처리하지 못했습니다. 다시 입장해 주세요.", true);
    }
  }

  function updateRoomPeers(participants) {
    state.presenceParticipants = participants;
    const activeIds = new Set(participants.map((participant) => participant.user_id));
    for (const [userId, peer] of state.peerConnections) {
      if (!activeIds.has(userId)) {
        peer.connection.close();
        state.peerConnections.delete(userId);
        state.remoteStreams.delete(userId);
      }
    }
    for (const participant of participants) {
      if (participant.user_id !== state.userId) createPeerConnection(participant.user_id);
    }
    if (state.page === "meeting") renderMeeting();
  }

  async function toggleDevice(device) {
    const isCamera = device === "camera";
    const enabledKey = isCamera ? "cameraEnabled" : "microphoneEnabled";
    const trackKind = isCamera ? "video" : "audio";
    const tracks = state.localMediaStream?.getTracks() || [];
    const currentTrack = tracks.find((track) => track.kind === trackKind && track.readyState === "live");

    if (state[enabledKey]) {
      if (!isCamera) stopSpeechRecognition();
      state[enabledKey] = false;
      if (!isCamera) state.recognitionStatus = "off";
      if (currentTrack) {
        state.localMediaStream.removeTrack(currentTrack);
        currentTrack.stop();
      }
      await Promise.all([...state.peerConnections.values()].map((peer) => syncPeerMedia(peer)))
        .catch((error) => {
          console.error(`Could not stop sending the ${device} track.`, error);
          toast(`상대방에게 ${device === "camera" ? "카메라" : "마이크"} 종료 상태를 전달하지 못했습니다.`, true);
        });
      syncPresence();
      renderMeeting();
      return;
    }

    try {
      if (currentTrack) {
        currentTrack.enabled = true;
      } else {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("이 브라우저에서 카메라와 마이크를 사용할 수 없습니다. HTTPS 또는 localhost로 접속해 주세요.");
        }
        const stream = isCamera
          ? await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
          : await acquireAvailableMicrophone();
        if (!isCamera) {
          const audioTrack = stream.getAudioTracks()[0];
          if (!audioTrack) throw new Error("사용 가능한 마이크에서 오디오를 가져오지 못했습니다.");
          watchMicrophoneTrack(audioTrack);
        }
        if (!state.localMediaStream) {
          state.localMediaStream = stream;
        } else {
          for (const track of stream.getTracks()) state.localMediaStream.addTrack(track);
        }
      }
      state[enabledKey] = true;
      if (!isCamera) {
        state.recognitionRetryCount = 0;
        state.recognitionNetworkNoticeShown = false;
        state.recognitionStatus = "connecting";
        startSpeechRecognitionSafely();
      }
      await Promise.all([...state.peerConnections.values()].map((peer) => syncPeerMedia(peer)));
      await Promise.all([...state.peerConnections.values()].map((peer) => requestPeerNegotiation(peer)));
      syncPresence();
      renderMeeting();
    } catch (error) {
      state[enabledKey] = false;
      if (!isCamera) {
        state.recognitionStatus = "off";
        stopSpeechRecognition();
        const audioTrack = state.localMediaStream?.getAudioTracks().find((track) => track.readyState === "live");
        if (audioTrack) {
          state.localMediaStream.removeTrack(audioTrack);
          audioTrack.stop();
        }
      } else {
        state.localMediaStream?.getVideoTracks().forEach((videoTrack) => {
          state.localMediaStream.removeTrack(videoTrack);
          videoTrack.stop();
        });
      }
      syncPresence();
      void Promise.all([...state.peerConnections.values()].map((peer) => syncPeerMedia(peer)))
        .catch((syncError) => console.error(`Could not stop sending the ${device} track after a device error.`, syncError));
      console.error(`Could not turn on the ${device}.`, error);
      const message = error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
        ? `${isCamera ? "카메라" : "마이크"} 권한이 거부되었습니다. 브라우저 사이트 설정에서 권한을 허용해 주세요.`
        : error.name === "NotFoundError" || error.name === "DevicesNotFoundError"
          ? `${isCamera ? "사용 가능한 카메라" : "사용 가능한 마이크"}를 찾을 수 없습니다.`
          : error.message?.startsWith("이 브라우저")
            ? error.message
            : `${isCamera ? "카메라" : "마이크"}를 켜지 못했습니다. 장치 연결과 브라우저 권한을 확인해 주세요.`;
      toast(message, true);
      if (state.page === "meeting") renderMeeting();
    }
  }

  function startSpeechRecognition(audioTrack = state.localMediaStream?.getAudioTracks().find((track) => track.readyState === "live")) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) throw new Error("이 브라우저는 자동 음성 인식을 지원하지 않습니다. 최신 Chrome 또는 Edge를 사용해 주세요.");
    const recognition = new Recognition();
    recognition.lang = state.language === "en" ? "en-US" : "ko-KR";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    state.recognition = recognition;
    state.recognitionStatus = "connecting";
    updateVoiceStatus();
    recognition.onstart = () => {
      if (state.recognition !== recognition) return;
      state.recognitionStatus = "listening";
      updateVoiceStatus();
    };
    recognition.onresult = (event) => {
      if (!state.microphoneEnabled || state.page !== "meeting") return;
      state.recognitionRetryCount = 0;
      state.recognitionNetworkNoticeShown = false;
      state.recognitionStatus = "listening";
      updateVoiceStatus();
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript?.trim();
        if (result.isFinal && transcript) void sendMessage(transcript, true);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "aborted" || event.error === "no-speech") return;
      console.error("Automatic speech recognition failed.", event.error);
      if (event.error === "network") {
        state.recognitionRetryCount += 1;
        state.recognitionStatus = state.recognitionRetryCount >= 3 ? "service-unavailable" : "reconnecting";
        updateVoiceStatus();
        if (!state.recognitionNetworkNoticeShown) {
          state.recognitionNetworkNoticeShown = true;
          toast("마이크는 연결되어 있지만 브라우저 음성 인식 서비스에 연결할 수 없습니다. 인터넷 연결과 브라우저의 음성 인식 서비스 접근을 확인해 주세요.", true);
        }
        return;
      }
      state.recognitionStatus = "unavailable";
      stopSpeechRecognition();
      const message = event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "자동 음성 인식 권한이 거부되었습니다. 통화 마이크는 계속 켜져 있습니다."
        : event.error === "language-not-supported"
          ? "선택한 언어의 음성 인식을 지원하지 않습니다. 통화 마이크는 계속 켜져 있습니다."
          : "자동 음성 인식을 사용할 수 없습니다. 통화 마이크는 계속 켜져 있습니다.";
      toast(message, true);
      updateVoiceStatus();
      if (state.page === "meeting") renderMeeting();
    };
    recognition.onend = () => {
      if (state.recognition !== recognition) return;
      state.recognition = null;
      if (!state.microphoneEnabled || state.page !== "meeting") return;
      clearTimeout(state.recognitionRestartTimer);
      if (state.recognitionStatus !== "service-unavailable") {
        state.recognitionStatus = "reconnecting";
        updateVoiceStatus();
      }
      const delay = state.recognitionRetryCount
        ? Math.min(30000, 1000 * (2 ** Math.min(state.recognitionRetryCount - 1, 5)))
        : 250;
      state.recognitionRestartTimer = setTimeout(() => {
        if (state.microphoneEnabled && state.page === "meeting" && !state.recognition) {
          const currentTrack = state.localMediaStream?.getAudioTracks().find((track) => track.readyState === "live");
          if (!currentTrack) {
            void recoverUnavailableMicrophone();
            return;
          }
          try {
            startSpeechRecognition(currentTrack);
          } catch (error) {
            console.error("Could not resume automatic speech recognition.", error);
            state.recognitionStatus = "unavailable";
            updateVoiceStatus();
            toast("자동 음성 인식을 다시 시작하지 못했습니다. 통화 마이크는 계속 켜져 있습니다.", true);
            renderMeeting();
          }
        }
      }, delay);
    };
    if (!audioTrack) throw new Error("선택한 마이크의 오디오 트랙을 찾을 수 없습니다.");
    try {
      recognition.start(audioTrack);
    } catch (error) {
      if (state.recognition === recognition) state.recognition = null;
      throw error;
    }
  }

  function startSpeechRecognitionSafely(audioTrack) {
    try {
      startSpeechRecognition(audioTrack);
    } catch (error) {
      console.error("Could not start automatic speech recognition.", error);
      state.recognitionStatus = "unavailable";
      updateVoiceStatus();
      toast("자동 음성 인식을 사용할 수 없습니다. 통화 마이크는 계속 켜져 있습니다.", true);
    }
  }

  function stopSpeechRecognition() {
    clearTimeout(state.recognitionRestartTimer);
    state.recognitionRestartTimer = null;
    const recognition = state.recognition;
    state.recognition = null;
    if (recognition) {
      try {
        recognition.stop();
      } catch (error) {
        if (error.name !== "InvalidStateError") {
          console.error("Could not stop speech recognition cleanly.", error);
        }
      }
    }
  }

  function stopLocalMedia() {
    stopSpeechRecognition();
    if (state.localMediaStream) {
      for (const track of state.localMediaStream.getTracks()) track.stop();
    }
    state.localMediaStream = null;
    state.cameraEnabled = false;
    state.microphoneEnabled = false;
    state.recognitionStatus = "off";
  }

  function updateMeetingClock() {
    if (state.page !== "meeting") return;
    const booking = activeBooking();
    const target = document.querySelector("#meeting-countdown");
    if (booking && target) target.textContent = ` · 남은 시간 ${countdown(booking.end - Date.now())}`;
  }

  function updateEntryClock() {
    const booking = activeBooking();
    if (!booking) return;
    const remaining = booking.start - Date.now();
    const waiting = remaining > 0;
    const heading = document.querySelector("#entry-state");
    const status = document.querySelector("#entry-countdown");
    const password = document.querySelector("#entry-password");
    if (heading) heading.textContent = waiting ? "아직 입실 시간이 아닙니다" : "예약 시간이 되었습니다";
    if (status) status.textContent = waiting
      ? `예약 시작까지 ${countdown(remaining)} 남았습니다. 예약 전에 입실할 수 없습니다.`
      : "예약 암호를 입력해 토론방에 참여하세요.";
    if (password) password.disabled = waiting;
    for (const button of document.querySelectorAll('[data-action="submit-entry"], [data-action="entry-key"]')) {
      button.disabled = waiting;
    }
  }

  function updateRoomAvailability() {
    if (state.page !== "room") return;
    for (const button of document.querySelectorAll('[data-action="enter-booking"]')) {
      const booking = state.bookings.find((item) => item.id === button.dataset.id);
      if (!booking) continue;
      const canJoin = Date.now() >= booking.start && Date.now() < booking.end;
      button.disabled = !canJoin;
      button.classList.toggle("secondary", !canJoin);
      button.textContent = canJoin ? "입실하기" : "예약 시간 전";
      const description = button.closest(".booking-item")?.querySelector("p");
      if (description) {
        description.textContent = `${formatTime(new Date(booking.start))}–${formatTime(new Date(booking.end))} · ${canJoin ? "진행 중" : "예약 완료"}`;
      }
    }
  }

  function purgeExpiredBookings() {
    const before = state.bookings.length;
    state.bookings = state.bookings.filter((booking) => booking.end > Date.now());
    return state.bookings.length !== before;
  }

  function render() {
    clearInterval(state.tickTimer);
    clearObjectUrls();
    if (state.page === "home") renderHome();
    else if (state.page === "booking") renderBooking();
    else if (state.page === "room") renderRoomInfo();
    else if (state.page === "notices") renderNotices();
    else if (state.page === "notice-detail") renderNoticeDetail();
    else if (state.page === "entry") renderEntry();
    else if (state.page === "meeting") renderMeeting();
    if (state.page === "entry" || state.page === "meeting" || state.page === "room" || state.page === "booking" || state.page === "home") {
      state.tickTimer = setInterval(async () => {
        if (state.page === "meeting") {
          const booking = activeBooking();
          if (booking && Date.now() >= booking.end) {
            await leaveMeeting(false);
            toast("예약 이용 시간이 끝나 임시 자료를 삭제했습니다.");
          } else {
            updateMeetingClock();
          }
        } else if (state.page === "entry") {
          const booking = activeBooking();
          if (booking && Date.now() >= booking.end) {
            state.bookings = state.bookings.filter((item) => item.id !== booking.id);
            state.activeBookingId = null;
            state.page = "room";
            render();
            toast("예약 이용 시간이 끝났습니다.");
          } else {
            updateEntryClock();
          }
        } else if ((state.page === "home" || state.page === "booking") &&
          state.backendReady && Date.now() - state.lastScheduleRefreshAt > 15000) {
          await refreshSchedule(state.page === "home" ? dateKey(new Date()) : state.selectedDate, state.page === "home" ? 30 : 1);
          render();
        } else if (state.page === "room" && state.backendReady &&
          Date.now() - state.lastScheduleRefreshAt > 15000) {
          await refreshRoomBookings(state.selectedRoom);
          render();
        } else {
          const changed = purgeExpiredBookings();
          if (changed) render();
          else updateRoomAvailability();
        }
      }, 1000);
    }
  }

  function toast(message, isError = false) {
    let element = document.querySelector(".toast");
    if (!element) {
      element = document.createElement("div");
      element.className = "toast";
      element.setAttribute("role", "status");
      document.body.append(element);
    }
    element.textContent = message;
    element.classList.toggle("error", isError);
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.remove(), 3600);
  }

  function showModal(contents, onReady) {
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="backdrop"><section class="modal-card" role="dialog" aria-modal="true">${contents}</section></div>`;
    if (onReady) onReady();
    const focusable = modalRoot.querySelector("button, input");
    if (focusable) focusable.focus();
  }

  function closeModal() {
    modalRoot.innerHTML = "";
  }

  function confirmReservation() {
    const password = document.querySelector("#reserve-password").value;
    if (!state.selectedSlot) return toast("먼저 예약 시간을 선택해 주세요.", true);
    if (password.length < 4) return toast("입실 암호는 4자 이상 입력해 주세요.", true);
    if (state.backendStatus === "connecting" || state.backendStatus === "error") {
      return toast("온라인 연결이 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.", true);
    }
    const start = localDateTime(state.selectedSlot.date, state.selectedSlot.minutes);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    if (start <= new Date()) return toast("이미 지난 시간은 예약할 수 없습니다.", true);
    if (!state.backendReady && bookingAt(state.selectedSlot.room, start.getTime(), end.getTime())) {
      render();
      return toast("선택한 시간은 방금 예약되었습니다. 다른 시간을 선택해 주세요.", true);
    }
    const message = `${formatKoreanDateTime(start)}에 예약 할까요?`;
    showModal(`<span class="eyebrow">Confirm reservation</span><h2 style="margin-top:8px">예약을 확인해 주세요</h2>
      <p><strong>${escapeHtml(state.selectedSlot.room)} 토론방</strong><br>${escapeHtml(message)}<br>기본 이용 2시간 · 10분 연장 1회 가능</p>
      <p class="small">참석자 정보는 미리 입력하지 않습니다. 암호는 서버에서 해시 처리됩니다.</p>
      <div class="modal-actions"><button class="button secondary" data-modal-action="cancel">취소</button><button class="button" data-modal-action="reserve">예약</button></div>`);
  }

  async function commitReservation() {
    const passwordInput = document.querySelector("#reserve-password");
    const password = passwordInput.value;
    const start = localDateTime(state.selectedSlot.date, state.selectedSlot.minutes);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    if (!state.backendReady && bookingAt(state.selectedSlot.room, start.getTime(), end.getTime())) {
      closeModal();
      render();
      return toast("선택한 시간은 방금 예약되었습니다. 다른 시간을 선택해 주세요.", true);
    }
    let booking;
    if (state.backendReady) {
      try {
        const session = await backend.connect();
        state.userId = session.user.id;
        const id = await backend.reserve(state.selectedSlot.room, start, password);
        booking = { id, room: state.selectedSlot.room, start: start.getTime(), end: end.getTime(), extended: false };
      } catch (error) {
        console.error("Reservation could not be created.", error);
        if (state.userId && error.message?.includes("TIME_SLOT_TAKEN")) {
          try {
            await backend.discardUnusedGuest();
            await backend.signOutAndForget();
            state.userId = null;
          } catch (cleanupError) {
            console.error("Could not discard the unused guest account.", cleanupError);
          }
        }
        closeModal();
        return toast(error.message?.includes("TIME_SLOT_TAKEN")
          ? "선택한 시간은 방금 예약되었습니다. 다른 시간을 선택해 주세요."
          : "예약하지 못했습니다. 암호와 방 예약 현황을 확인해 주세요.", true);
      }
    } else {
      booking = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        room: state.selectedSlot.room,
        start: start.getTime(),
        end: end.getTime(),
        password,
        extended: false
      };
    }
    state.bookings = state.bookings.filter((item) => item.id !== booking.id);
    state.bookings.push(booking);
    state.lastCreatedBookingId = booking.id;
    passwordInput.value = "";
    state.selectedRoom = booking.room;
    const inviteUrl = new URL(location.href);
    inviteUrl.searchParams.set("reservation", booking.id);
    const link = inviteUrl.href;
    closeModal();
    showModal(`<span class="eyebrow">Reservation complete</span><h2 style="margin-top:8px">예약되었습니다</h2>
      <p><strong>${escapeHtml(formatKoreanDateTime(start))}에 예약 되었습니다.</strong><br>${escapeHtml(booking.room)} 토론방 · 종료 예정 ${escapeHtml(formatTime(end))}</p>
      <div class="field"><label for="invite-link">${state.backendReady ? "참석 초대 링크" : "시연용 초대 링크"}</label><input id="invite-link" readonly value="${escapeHtml(link)}"><p class="field-hint">${state.backendReady ? "참석자는 링크를 열고 예약 시간에 암호를 입력해 입장합니다." : "서버가 없는 시연 링크는 현재 탭에서만 작동합니다."}</p></div>
      <div class="modal-actions"><button class="button secondary" data-modal-action="copy-link">링크 복사</button><button class="button" data-modal-action="done">예약 확인</button></div>`);
  }

  async function submitEntry() {
    const booking = activeBooking();
    if (!booking) return;
    const name = document.querySelector("#participant-name").value.trim();
    const password = document.querySelector("#entry-password").value;
    const error = document.querySelector("#entry-error");
    if (Date.now() < booking.start) {
      error.textContent = "예약 시작 전에는 입실할 수 없습니다.";
      return;
    }
    if (Date.now() >= booking.end) {
      error.textContent = "예약 이용 시간이 종료되었습니다.";
      return;
    }
    if (!name) {
      error.textContent = "참가자 이름을 입력해 주세요.";
      return;
    }
    if (state.backendReady) {
      let joined;
      try {
        const session = await backend.connect();
        state.userId = session.user.id;
        joined = await backend.join(booking.id, password, name);
      } catch (joinError) {
        console.error("Could not join the reservation.", joinError);
        error.textContent = joinError.message?.includes("INVALID_PASSWORD")
          ? "암호가 일치하지 않습니다. 다시 확인해 주세요."
          : joinError.message?.includes("RESERVATION_NOT_OPEN")
            ? "예약 시간 전이거나 이용 시간이 종료되었습니다."
            : "입실하지 못했습니다. 예약 암호와 네트워크를 확인해 주세요.";
        return;
      }

      const row = Array.isArray(joined) ? joined[0] : joined;
      const joinedEnd = new Date(row?.ends_at).getTime();
      if (!Number.isFinite(joinedEnd)) {
        console.error("The join reservation response did not include a valid end time.", row);
        error.textContent = "입실 응답을 확인하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.";
        return;
      }
      booking.room = row.room_id || booking.room;
      booking.end = joinedEnd;
      state.currentName = name;
      state.page = "meeting";
      state.messages = [];
      state.sharedItems = [];
      state.activeShareIndex = -1;
      render();
      await refreshMeetingData("all");
      if (state.unsubscribeRoom) state.unsubscribeRoom();
      state.roomChannel = backend.subscribe(booking.id, {
        userId: state.userId,
        displayName: state.currentName,
        cameraEnabled: state.cameraEnabled,
        microphoneEnabled: state.microphoneEnabled
      }, (change, error) => {
        if (change === "error") {
          console.error("Realtime subscription failed.", error);
          toast("실시간 연결이 끊겼습니다. 새로고침 후 다시 입장해 주세요.", true);
        } else {
          void refreshMeetingData(change);
        }
      }, (userId, signal) => { void handlePeerSignal(userId, signal); }, updateRoomPeers);
      state.unsubscribeRoom = () => state.roomChannel?.unsubscribe();
      return;
    }
    if (password !== booking.password) {
      error.textContent = "암호가 일치하지 않습니다. 다시 확인해 주세요.";
      return;
    }
    state.currentName = name;
    state.page = "meeting";
    state.messages = [{
      name: "우리방 안내", text: `${name}님, 반갑습니다. 먼저 자기소개를 해 주세요. 음성 또는 키보드 입력을 사용할 수 있습니다.`,
      time: Date.now(), system: true
    }];
    state.sharedItems = [];
    render();
  }

  async function sendMessage(text, voice = false) {
    const message = text.trim();
    if (!message) return false;
    if (state.backendReady) {
      const booking = activeBooking();
      try {
        await backend.sendMessage(booking.id, message, voice ? "voice" : "text");
        await refreshMeetingData("messages");
        return true;
      } catch (error) {
        console.error("Could not send room message.", error);
        toast("메시지를 전송하지 못했습니다. 연결 상태를 확인해 주세요.", true);
        return false;
      }
    }
    state.messages.push({ name: state.currentName, text: message, time: Date.now(), mine: true, voice });
    renderMeeting();
    return true;
  }

  async function leaveMeeting(save, alreadyEnded = false) {
    const booking = activeBooking();
    if (!booking) return;
    if (save) {
      const downloaded = await downloadSession(booking);
      if (!downloaded) return;
    }
    let cleanupPending = false;
    let cleanupError = null;
    let cleanupFailureStage = null;
    if (state.unsubscribeRoom) {
      state.unsubscribeRoom();
      state.unsubscribeRoom = null;
    }
    for (const peer of state.peerConnections.values()) peer.connection.close();
    state.peerConnections.clear();
    state.remoteStreams.clear();
    state.presenceParticipants = [];
    state.roomChannel = null;
    state.remoteAudioBlocked = false;
    stopLocalMedia();
    if (state.backendReady && !alreadyEnded) {
      try {
        const isLastParticipant = await backend.leave(booking.id);
        if (isLastParticipant) {
          state.pendingCleanupId = booking.id;
          cleanupFailureStage = "function";
          await finishServerCleanup(booking.id);
        }
      } catch (error) {
        cleanupPending = true;
        cleanupError = error;
        if (cleanupFailureStage === "function" && !state.pendingCleanupId) cleanupFailureStage = "session";
        if (!cleanupFailureStage) cleanupFailureStage = "leave";
        console.error("Could not complete server-side room cleanup.", error);
      }
    }
    if (state.backendReady && alreadyEnded) {
      try {
        await backend.signOutAndForget();
        state.userId = null;
      } catch (error) {
        cleanupPending = true;
        cleanupError = error;
        cleanupFailureStage = "session";
        state.backendReady = false;
        state.backendStatus = "error";
        console.error("Could not refresh guest session after room cleanup.", error);
      }
    }
    const room = booking.room;
    state.bookings = state.bookings.filter((item) => item.id !== booking.id);
    state.activeBookingId = null;
    state.messages = [];
    clearObjectUrls();
    state.sharedItems = [];
    state.currentName = "";
    state.page = "home";
    render();
    if (cleanupPending) {
      const detail = cleanupError instanceof Error && cleanupError.message
        ? ` 오류: ${cleanupError.message.slice(0, 180)}`
        : "";
      const guidance = cleanupFailureStage === "leave"
        ? "퇴장 기록 저장에 실패했습니다. 네트워크와 Supabase RPC를 확인해 주세요."
        : cleanupFailureStage === "session"
          ? "세션을 초기화하지 못했습니다. 페이지를 새로고침해 주세요."
          : "홈 화면에서 정리 재시도를 선택하거나 Supabase 함수 로그를 확인해 주세요.";
      toast(`방에서 나왔지만 서버 정리가 완료되지 않았습니다.${detail} ${guidance}`, true);
    } else {
      toast(`${room} 토론방을 나왔습니다. ${state.backendReady ? "다른 참가자가 남아 있어 방은 계속 진행 중입니다." : "임시 자료를 삭제했습니다."}${save ? " 선택한 결과물은 PC에 다운로드되었습니다." : ""}`);
    }
  }

  async function finishServerCleanup(reservationId) {
    await backend.cleanupRoom(reservationId);
    state.pendingCleanupId = null;
    state.backendReady = true;
    state.backendStatus = "connected";
    state.userId = null;
    await backend.signOutAndForget();
  }

  async function downloadSession(booking) {
    const date = new Date(booking.start);
    const fileDate = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const fileTime = `${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
    const baseName = `${booking.room}방${fileDate}_${fileTime}`;
    try {
      const sharedItems = state.backendReady
        ? await loadSharedItemsForDownload(booking.id)
        : [...state.sharedItems];
      const transcript = [
        `우리방 대화 대본`,
        `방: ${booking.room} 토론방`,
        `토론 시작 예정: ${formatFull(new Date(booking.start))}`,
        `종료 시각: ${formatFull(new Date())}`,
        `참가자: ${state.currentName}`,
        "",
        "대화 내용",
        ...state.messages.map((message) => message.system
          ? `[안내] ${message.text}`
          : `[${formatTime(new Date(message.time))}] ${message.name}${message.voice ? " (음성 입력)" : ""}: ${message.text}`),
        "",
        "공유 자료",
        ...sharedItems.map((item) => item.kind === "link" ? `${item.name}: ${item.url}` : `${item.name} (ZIP에 포함)`)
      ].join("\r\n");
      const entries = [{ name: "대화대본.txt", data: new TextEncoder().encode(transcript) }];
      const usedNames = new Set();
      for (const item of sharedItems) {
        if (item.kind === "file") {
          const safeName = uniqueArchiveFilename(item.name, usedNames);
          entries.push({ name: `공유자료/${safeName}`, data: new Uint8Array(await item.file.arrayBuffer()) });
        }
      }
      const blob = makeZip(entries);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${baseName}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (error) {
      console.error("대화 자료를 압축하거나 다운로드하지 못했습니다.", error);
      const detail = error instanceof Error && error.message ? ` (${error.message.slice(0, 160)})` : "";
      toast(`공유 파일을 포함한 저장 파일을 만들지 못했습니다${detail}`, true);
      return false;
    }
  }

  async function loadSharedItemsForDownload(reservationId) {
    const rows = await backend.sharedFiles(reservationId);
    const items = [];
    for (const row of rows) {
      if (row.external_url) {
        items.push({ id: row.id, kind: "link", name: row.original_name, url: row.external_url });
      } else if (row.storage_path) {
        try {
          const file = await backend.downloadSharedFile(row.storage_path);
          if (!(file instanceof Blob)) throw new Error("다운로드한 파일이 올바르지 않습니다.");
          items.push({ id: row.id, kind: "file", name: row.original_name, file, storagePath: row.storage_path });
        } catch (error) {
          const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
          throw new Error(`공유 파일 "${row.original_name}"을 내려받지 못했습니다${detail}`);
        }
      } else {
        throw new Error(`공유 파일 "${row.original_name}"의 저장 위치를 확인할 수 없습니다.`);
      }
    }
    return items;
  }

  function sanitizeFilename(name) {
    const safe = name.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
    return safe || "shared-file";
  }

  function uniqueArchiveFilename(name, usedNames) {
    const safeName = sanitizeFilename(name);
    if (!usedNames.has(safeName)) {
      usedNames.add(safeName);
      return safeName;
    }
    const dot = safeName.lastIndexOf(".");
    const base = dot > 0 ? safeName.slice(0, dot) : safeName;
    const extension = dot > 0 ? safeName.slice(dot) : "";
    let suffix = 2;
    let candidate = `${base} (${suffix})${extension}`;
    while (usedNames.has(candidate)) {
      suffix += 1;
      candidate = `${base} (${suffix})${extension}`;
    }
    usedNames.add(candidate);
    return candidate;
  }

  function makeZip(entries) {
    const encoder = new TextEncoder();
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    const crc32 = (bytes) => {
      let crc = 0xffffffff;
      for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    };
    const chunks = [];
    const directory = [];
    let offset = 0;
    const write16 = (view, position, value) => view.setUint16(position, value, true);
    const write32 = (view, position, value) => view.setUint32(position, value, true);

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const localView = new DataView(local.buffer);
      write32(localView, 0, 0x04034b50);
      write16(localView, 4, 20);
      write16(localView, 6, 0x0800);
      write16(localView, 8, 0);
      write16(localView, 10, 0);
      write16(localView, 12, 0x21);
      write32(localView, 14, crc);
      write32(localView, 18, data.length);
      write32(localView, 22, data.length);
      write16(localView, 26, name.length);
      write16(localView, 28, 0);
      local.set(name, 30);
      chunks.push(local, data);

      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      write32(centralView, 0, 0x02014b50);
      write16(centralView, 4, 20);
      write16(centralView, 6, 20);
      write16(centralView, 8, 0x0800);
      write16(centralView, 10, 0);
      write16(centralView, 12, 0);
      write16(centralView, 14, 0x21);
      write32(centralView, 16, crc);
      write32(centralView, 20, data.length);
      write32(centralView, 24, data.length);
      write16(centralView, 28, name.length);
      write16(centralView, 30, 0);
      write16(centralView, 32, 0);
      write16(centralView, 34, 0);
      write16(centralView, 36, 0);
      write32(centralView, 38, 0);
      write32(centralView, 42, offset);
      central.set(name, 46);
      directory.push(central);
      offset += local.length + data.length;
    }
    const centralSize = directory.reduce((sum, chunk) => sum + chunk.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    write32(endView, 0, 0x06054b50);
    write16(endView, 4, 0);
    write16(endView, 6, 0);
    write16(endView, 8, entries.length);
    write16(endView, 10, entries.length);
    write32(endView, 12, centralSize);
    write32(endView, 16, offset);
    write16(endView, 20, 0);
    return new Blob([...chunks, ...directory, end], { type: "application/zip" });
  }

  async function copyInviteLink() {
    const input = document.querySelector("#invite-link");
    try {
      await navigator.clipboard.writeText(input.value);
      toast("초대 링크를 복사했습니다.");
    } catch {
      input.select();
      const copied = document.execCommand("copy");
      if (copied) toast("시연용 링크를 복사했습니다. 다른 탭이나 기기에서는 입장할 수 없습니다.");
      else toast("링크 복사에 실패했습니다. 직접 선택해 복사해 주세요.", true);
    }
  }

  function enterBooking(id) {
    const booking = state.bookings.find((item) => item.id === id);
    if (!booking) return toast("예약 정보를 찾을 수 없습니다.", true);
    if (Date.now() < booking.start) return toast(`예약 시작 시각(${formatTime(new Date(booking.start))}) 이후 입실할 수 있습니다.`, true);
    if (Date.now() >= booking.end) return toast("예약 이용 시간이 종료되었습니다.", true);
    state.activeBookingId = id;
    state.currentName = "";
    state.page = "entry";
    render();
  }

  async function doExtend() {
    const booking = activeBooking();
    if (!booking) return;
    if (booking.extended) return toast("예약당 1회만 연장할 수 있습니다.", true);
    if (state.backendReady) {
      try {
        booking.end = new Date(await backend.extend(booking.id)).getTime();
        booking.extended = true;
        await refreshMeetingData("reservation");
        toast(`이용 시간이 10분 연장되었습니다. 종료 예정 시각: ${formatTime(new Date(booking.end))}`);
      } catch (error) {
        console.error("Could not extend room booking.", error);
        toast(error.message?.includes("EXTENSION_CONFLICT")
          ? "다음 예약과 겹쳐 연장할 수 없습니다."
          : "연장하지 못했습니다. 이미 사용했거나 이용이 종료되었는지 확인해 주세요.", true);
      }
      return;
    }
    const proposedEnd = booking.end + 10 * 60 * 1000;
    const conflict = state.bookings.find((other) => other.id !== booking.id &&
      other.room === booking.room && other.start < proposedEnd && other.end > booking.end);
    if (conflict) return toast("다음 예약과 겹쳐 연장할 수 없습니다.", true);
    booking.end = proposedEnd;
    booking.extended = true;
    state.messages.push({ name: "우리방 안내", text: `이용 시간이 10분 연장되었습니다. 종료 예정 시각: ${formatTime(new Date(booking.end))}`, time: Date.now(), system: true });
    render();
  }

  async function handleAction(action, element) {
    if (action === "home") {
      if (state.page === "meeting") {
        showModal(`<h2>토론방을 나갈까요?</h2><p>저장하지 않은 대화와 공유 자료는 삭제됩니다. 필요한 자료가 있으면 먼저 <strong>저장/종료</strong>를 선택해 주세요.</p><div class="modal-actions"><button class="button secondary" data-modal-action="cancel">계속 대화하기</button><button class="button danger" data-modal-action="leave">나가기</button></div>`);
        return;
      }
      state.page = "home";
      state.selectedSlot = null;
      render();
    } else if (action === "booking") {
      state.page = "booking";
      state.selectedSlot = null;
      state.selectedDate = dateKey(new Date());
      await refreshSchedule(state.selectedDate);
      render();
    } else if (action === "notices") {
      state.page = "notices";
      render();
    } else if (action === "notice-detail") {
      state.noticeIndex = Number(element.dataset.index);
      state.page = "notice-detail";
      render();
    } else if (action === "room") {
      state.selectedRoom = element.dataset.room;
      state.page = "room";
      await refreshRoomBookings(state.selectedRoom);
      render();
    } else if (action === "select-slot") {
      state.selectedRoom = element.dataset.room;
      state.selectedSlot = { room: element.dataset.room, minutes: Number(element.dataset.minutes), date: state.selectedDate };
      render();
    } else if (action === "date-step") {
      const date = dateFromKey(state.selectedDate);
      date.setDate(date.getDate() + Number(element.dataset.step));
      if (dateKey(date) < dateKey(new Date())) return toast("지난 날짜는 선택할 수 없습니다.", true);
      state.selectedDate = dateKey(date);
      state.selectedSlot = null;
      await refreshSchedule(state.selectedDate);
      render();
    } else if (action === "confirm-reservation") {
      confirmReservation();
    } else if (action === "enter-booking") {
      enterBooking(element.dataset.id);
    } else if (action === "submit-entry") {
      void submitEntry();
    } else if (action === "entry-key") {
      const input = document.querySelector("#entry-password");
      if (!input || input.disabled) return;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.setRangeText(element.dataset.key, start, end, "end");
      input.focus();
      const error = document.querySelector("#entry-error");
      if (error) error.textContent = "";
    } else if (action === "select-shared") {
      if (state.activeShareIndex >= 0) {
        return toast("먼저 공유 화면을 닫아 주세요.", true);
      }
      state.activeShareIndex = Number(element.dataset.index);
      state.shareZoom = 1;
      closeModal();
      render();
    } else if (action === "shared-files") {
      openSharedFilesDialog();
    } else if (action === "participant-preview") {
      openParticipantPreview(Number(element.dataset.index));
    } else if (action === "share-file") {
      document.querySelector("#share-file-input")?.click();
    } else if (action === "clear-share") {
      state.activeShareIndex = -1;
      state.shareZoom = 1;
      render();
    } else if (action === "share-zoom") {
      state.shareZoom = Math.min(2, Math.max(.5, state.shareZoom + Number(element.dataset.step) * .1));
      const content = document.querySelector(".share-content");
      const zoomValue = document.querySelector("#share-zoom-value");
      if (content) content.style.setProperty("--share-zoom", state.shareZoom);
      if (zoomValue) zoomValue.textContent = `${Math.round(state.shareZoom * 100)}%`;
    } else if (action === "toggle-device") {
      await toggleDevice(element.dataset.device);
    } else if (action === "enable-remote-audio") {
      try {
        await Promise.all([...document.querySelectorAll("[data-remote-audio]")].map((audio) => audio.play()));
        state.remoteAudioBlocked = false;
        renderMeeting();
      } catch (error) {
        console.error("Could not enable participant audio playback.", error);
        toast("상대방 소리를 재생하지 못했습니다. 브라우저의 소리 재생 권한을 확인해 주세요.", true);
      }
    } else if (action === "extend") {
      await doExtend();
    } else if (action === "leave") {
      showModal(`<h2>토론방을 나갈까요?</h2><p>저장하지 않은 대화와 공유 자료는 삭제됩니다. 필요한 자료가 있으면 먼저 <strong>저장/종료</strong>를 선택해 주세요.</p><div class="modal-actions"><button class="button secondary" data-modal-action="cancel">계속 대화하기</button><button class="button danger" data-modal-action="leave">나가기</button></div>`);
    } else if (action === "save-exit") {
      showModal(`<h2>저장 하시겠습니까?</h2><p>모든 참가자가 공유한 파일과 대화 대본을 ZIP으로 내 PC에 다운로드한 뒤 나갑니다. 외부 링크의 대상 파일은 포함되지 않고 링크만 기록됩니다.</p><div class="modal-actions"><button class="button secondary" data-modal-action="leave">나가기</button><button class="button" data-modal-action="save">저장</button></div>`);
    } else if (action === "retry-cleanup") {
      if (!state.pendingCleanupId) return;
      try {
        await finishServerCleanup(state.pendingCleanupId);
        render();
        toast("회의의 서버 임시 자료를 삭제했습니다.");
      } catch (error) {
        console.error("Room cleanup retry failed.", error);
        render();
        const detail = error instanceof Error && error.message
          ? ` 오류: ${error.message.slice(0, 180)}`
          : "";
        const guidance = state.pendingCleanupId
          ? "Supabase 함수 로그를 확인해 주세요."
          : "서버 정리는 완료됐을 수 있습니다. 페이지를 새로고침해 세션을 초기화해 주세요.";
        toast(`정리 재시도에 실패했습니다.${detail} ${guidance}`, true);
      }
    }
  }

  app.addEventListener("click", (event) => {
    const element = event.target.closest("[data-action]");
    if (!element) return;
    event.preventDefault();
    handleAction(element.dataset.action, element);
  });

  modalRoot.addEventListener("click", async (event) => {
    if (modalRoot.querySelector(".participant-preview-dialog") && event.target.closest(".participant-preview")) {
      closeModal();
      return;
    }
    const element = event.target.closest("[data-modal-action]");
    if (!element) {
      if (event.target.classList.contains("modal-backdrop")) closeModal();
      return;
    }
    const action = element.dataset.modalAction;
    if (action === "cancel") closeModal();
    else if (action === "reserve") await commitReservation();
    else if (action === "done") {
      closeModal();
      state.page = "room";
      if (state.backendReady) await refreshRoomBookings(state.selectedRoom);
      render();
      const booking = state.bookings.find((item) => item.id === state.lastCreatedBookingId);
      if (booking) toast(`${formatKoreanDateTime(new Date(booking.start))}에 예약 되었습니다.`);
    } else if (action === "copy-link") await copyInviteLink();
    else if (action === "leave") {
      closeModal();
      await leaveMeeting(false);
    } else if (action === "save") {
      closeModal();
      await leaveMeeting(true);
    } else if (action === "choose-file") {
      closeModal();
      document.querySelector("#share-file-input")?.click();
    } else if (action === "select-shared") {
      if (state.activeShareIndex >= 0) return toast("먼저 공유 화면을 닫아 주세요.", true);
      state.activeShareIndex = Number(element.dataset.index);
      state.shareZoom = 1;
      closeModal();
      render();
    } else if (action === "ask-delete-shared") {
      const index = Number(element.closest(".shared-file-row")?.querySelector('[data-modal-action="select-shared"]')?.dataset.index);
      const item = state.sharedItems[index];
      if (!item) return;
      showModal(`<h2>공유 파일을 삭제할까요?</h2><p><strong>${escapeHtml(item.name)}</strong> 파일을 토론방의 공유 목록과 저장소에서 삭제합니다. 이 작업은 되돌릴 수 없습니다.</p><div class="modal-actions"><button class="button secondary" data-modal-action="cancel">취소</button><button class="button danger" data-modal-action="confirm-delete-shared" data-index="${index}">삭제</button></div>`);
    } else if (action === "confirm-delete-shared") {
      await deleteSharedItem(Number(element.dataset.index));
    }
  });

  app.addEventListener("submit", async (event) => {
    if (event.target.id !== "chat-form") return;
    event.preventDefault();
    const input = document.querySelector("#chat-input");
    const message = input.value;
    input.value = "";
    const sent = await sendMessage(message);
    if (!sent && document.querySelector("#chat-input") === input) input.value = message;
  });

  app.addEventListener("change", async (event) => {
    if (event.target.id === "meeting-language") {
      state.language = event.target.value === "en" ? "en" : "ko";
      const status = document.querySelector("#language-status");
      if (status) status.textContent = `선택 언어: ${state.language === "ko" ? "한국어" : "English"} · 자동 번역은 다음 단계에서 연결됩니다.`;
      if (state.microphoneEnabled) {
        stopSpeechRecognition();
        startSpeechRecognitionSafely();
      }
    } else if (event.target.id === "booking-date") {
      const value = event.target.value;
      if (!value || value < dateKey(new Date())) {
        toast("오늘 이후 날짜를 선택해 주세요.", true);
        return render();
      }
      state.selectedDate = value;
      state.selectedSlot = null;
      await refreshSchedule(value);
      render();
    } else if (event.target.id === "share-file-input") {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) {
        event.target.value = "";
        return toast("25MB 이하 파일을 선택해 주세요.", true);
      }
      const extension = file.name.split(".").pop().toLowerCase();
      const supportedExtensions = new Set([
        "pdf", "png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mov", "m4v",
        "txt", "csv", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "zip"
      ]);
      if (!supportedExtensions.has(extension)) {
        event.target.value = "";
        return toast("PDF, 이미지, 동영상, 문서, ZIP 파일만 공유할 수 있습니다.", true);
      }
      if (state.backendReady) {
        try {
          await backend.uploadSharedFile(activeBooking().id, file);
          await refreshMeetingData("shared");
        } catch (error) {
          console.error("Could not upload shared file.", error);
          const errorMessage = String(error.message || "").toLowerCase();
          const status = Number(error.statusCode || error.status);
          if (error.shareStage === "upload" && (status === 403 || errorMessage.includes("row-level security"))) {
            return toast("파일 업로드 권한이 거부되었습니다. 회의 참가 상태와 Supabase realtime.sql의 Storage 정책 적용 여부를 확인해 주세요.", true);
          }
          if (error.shareStage === "upload" && (status === 404 || errorMessage.includes("bucket not found"))) {
            return toast("공유 저장소가 없습니다. Supabase에 supabase/realtime.sql을 적용해 주세요.", true);
          }
          if (status === 413 || errorMessage.includes("exceeded the maximum") || errorMessage.includes("file size")) {
            return toast("파일이 저장소 용량 제한을 초과했습니다. 25MB 이하 파일을 선택해 주세요.", true);
          }
          const stage = error.shareStage === "register" ? "파일 정보 등록" : "파일 업로드";
          const detail = error.message ? ` (${error.message.slice(0, 160)})` : "";
          return toast(`${stage}에 실패했습니다${detail}`, true);
        }
      } else {
        state.sharedItems.push({ kind: "file", name: file.name, file });
        if (state.activeShareIndex < 0) state.activeShareIndex = state.sharedItems.length - 1;
        state.messages.push({ name: "우리방 안내", text: `파일을 공유했습니다: ${file.name}`, time: Date.now(), system: true });
      }
      render();
    }
  });

  modalRoot.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });

  navigator.mediaDevices?.addEventListener("devicechange", () => {
    if (state.page === "meeting" && state.microphoneEnabled) void recoverUnavailableMicrophone(true);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modalRoot.childElementCount) closeModal();
  });

  const inviteId = new URLSearchParams(location.search).get("reservation");
  if (inviteId) {
    state.activeBookingId = inviteId;
    state.page = "entry";
  }
  render();
  void initializeBackend();
})();
