// ================= CONFIG =================
const CLIENT_ID = "PASTE_YOUR_CLIENT_ID";
const CLIENT_SECRET = "PASTE_YOUR_CLIENT_SECRET";
const REFRESH_TOKEN = "PASTE_YOUR_REFRESH_TOKEN";
const STEP_GOAL = 10000;
const DEBUG = false; // set true and re-run (not as a widget) to see raw API responses again if something looks wrong
let debugLog = [];
const SCRIPT_NAME = "Fitbit Air"; // must exactly match this script's name inside Scriptable
// Tapping a card opens Scriptable and re-runs this script, pulling fresh data for all three
// metrics (they're fetched together). iOS does not let third-party widgets refresh silently
// in place on tap — this is the closest real equivalent.
const REFRESH_URL = "scriptable:///run/" + encodeURIComponent(SCRIPT_NAME);

// ================= THEME =================
const THEME = {
  cardBg: new Color("#1C1C1E"),
  labelGray: new Color("#98989D"),
  battery: { a: new Color("#30D158"), b: new Color("#7BF0A8"), icon: new Color("#30D158") },
  steps:   { a: new Color("#0A84FF"), b: new Color("#7AD6FF"), icon: new Color("#0A84FF") },
  gold:    { a: new Color("#FFB300"), b: new Color("#FFE873"), icon: new Color("#FFD60A") },
  heart:   { a: new Color("#A50E14"), b: new Color("#FF375F"), icon: new Color("#FF375F") },
};
const TRACK_ALPHA = 0.30; // brighter background ring

function uiFont(size, bold) {
  // Segoe UI is not shipped on iOS — this silently falls back to the system font (SF Pro) when unavailable.
  try {
    const f = new Font(bold ? "SegoeUI-Bold" : "SegoeUI", size);
    if (f) return f;
  } catch (e) {}
  return bold ? Font.boldSystemFont(size) : Font.systemFont(size);
}

// ================= AUTH =================
async function getAccessToken() {
  const req = new Request("https://oauth2.googleapis.com/token");
  req.method = "POST";
  req.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  req.body = `client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}&refresh_token=${encodeURIComponent(REFRESH_TOKEN)}&grant_type=refresh_token`;
  const res = await req.loadJSON();
  if (!res.access_token) throw new Error("Token refresh failed — refresh token may have expired.");
  return res.access_token;
}

async function apiGet(url, token) {
  const req = new Request(url);
  req.headers = { "Authorization": `Bearer ${token}` };
  const json = await req.loadJSON();
  if (DEBUG) debugLog.push(url + "\n\n" + JSON.stringify(json, null, 2));
  return json;
}

// ================= DATA =================
async function getBattery(token) {
  const res = await apiGet("https://health.googleapis.com/v4/users/me/pairedDevices", token);
  const device = res.pairedDevices && res.pairedDevices[0];
  if (!device) throw new Error("No paired device returned.");
  return { level: device.batteryLevel, name: device.deviceVersion };
}

function todayFilter(field) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  return `${field} >= "${start.toISOString()}" AND ${field} <= "${end.toISOString()}"`;
}

function isSameLocalDay(iso, ref) {
  const d = new Date(iso);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
}

async function getSteps(token) {
  // Confirmed field shape: dataPoints[].steps.count (string) + steps.interval.startTime.
  // No server-side filter — Google rejected every field-name guess for one — so today's
  // range and the Fitbit-only filter both happen client-side instead.
  const url = "https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints?pageSize=1000";
  const res = await apiGet(url, token);
  const points = res.dataPoints || [];
  const today = new Date();
  let total = 0;
  for (const p of points) {
    // Steps are reported by BOTH the Fitbit Air and, separately, iPhone HealthKit (synced via
    // Apple Health). Counting both would double-count — keep Fitbit's readings only.
    if (p?.dataSource?.platform !== "FITBIT") continue;
    const start = p?.steps?.interval?.startTime;
    if (!start || !isSameLocalDay(start, today)) continue;
    const count = Number(p?.steps?.count);
    if (!isNaN(count)) total += count;
  }
  return { total };
}

async function getHeartRate(token) {
  // Confirmed field shape: dataPoints[].heartRate.beatsPerMinute (string). The API returns
  // newest-first, so the latest reading is points[0], not the last item.
  const url = "https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints?pageSize=15";
  const res = await apiGet(url, token);
  const points = res.dataPoints || [];
  const latest = points.find(p => p?.dataSource?.platform === "FITBIT") || points[0];
  const bpm = latest?.heartRate?.beatsPerMinute;
  return { bpm: !isNaN(Number(bpm)) ? Math.round(Number(bpm)) : null };
}

// ================= COLOR MATH =================
function toHexByte(v) {
  const n = Math.max(0, Math.min(255, Math.round(v * 255)));
  return n.toString(16).padStart(2, "0");
}
function rgbHex(c) {
  return `#${toHexByte(c.red)}${toHexByte(c.green)}${toHexByte(c.blue)}`;
}
function withAlpha(c, alpha) {
  return new Color(rgbHex(c), alpha);
}
function lerpColor(c1, c2, t) {
  return new Color(`#${toHexByte(c1.red + (c2.red - c1.red) * t)}` +
    `${toHexByte(c1.green + (c2.green - c1.green) * t)}` +
    `${toHexByte(c1.blue + (c2.blue - c1.blue) * t)}`);
}

// ================= RING DRAWING =================
function ptOnCircle(center, radius, deg) {
  const a = (deg - 90) * Math.PI / 180; // 0° = 12 o'clock
  return new Point(center.x + radius * Math.cos(a), center.y + radius * Math.sin(a));
}

function drawDot(ctx, center, r, color) {
  ctx.setFillColor(color);
  ctx.fillEllipse(new Rect(center.x - r, center.y - r, r * 2, r * 2));
}

function drawTrack(ctx, center, radius, width, color) {
  const path = new Path();
  for (let i = 0; i <= 240; i++) {
    const p = ptOnCircle(center, radius, 360 * (i / 240));
    if (i === 0) path.move(p); else path.addLine(p);
  }
  ctx.addPath(path);
  ctx.setStrokeColor(color);
  ctx.setLineWidth(width);
  ctx.strokePath();
}

// One lap of progress: gradient along the arc, round caps at both ends (no taper/point).
function drawRingArc(ctx, center, radius, width, sweepDeg, colorA, colorB) {
  if (sweepDeg <= 0) return;
  const segments = Math.max(8, Math.round(sweepDeg * 2.2));

  for (let i = 0; i < segments; i++) {
    const d0 = sweepDeg * (i / segments);
    const d1 = sweepDeg * ((i + 1) / segments);
    const path = new Path();
    path.move(ptOnCircle(center, radius, d0));
    path.addLine(ptOnCircle(center, radius, d1));
    ctx.addPath(path);
    ctx.setStrokeColor(lerpColor(colorA, colorB, i / segments));
    ctx.setLineWidth(width);
    ctx.strokePath();
  }
  // round caps at both ends (the squircle-ish, non-pointy look)
  drawDot(ctx, ptOnCircle(center, radius, 0), width / 2, colorA);
  drawDot(ctx, ptOnCircle(center, radius, sweepDeg), width / 2, lerpColor(colorA, colorB, 1));
}

// At/over goal: the whole ring switches to a single solid gold lap instead of stacking a
// second partial lap on top — a clean "goal met" state rather than an overflow readout.
function makeRingImage(percent, theme, overflowTheme, valueText, size) {
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const center = new Point(size / 2, size / 2);
  const width = 11;
  const radius = size / 2 - width;
  const beatGoal = percent >= 1 && overflowTheme;
  const ringTheme = beatGoal ? overflowTheme : theme;
  const mid = lerpColor(ringTheme.a, ringTheme.b, 0.5);

  drawTrack(ctx, center, radius, width, withAlpha(mid, TRACK_ALPHA));
  const sweep = beatGoal ? 360 : 360 * Math.max(0, Math.min(percent, 1));
  drawRingArc(ctx, center, radius, width, sweep, ringTheme.a, ringTheme.b);

  ctx.setTextAlignedCenter();
  ctx.setFont(uiFont(size * 0.21, true));
  ctx.setTextColor(Color.white());
  ctx.drawTextInRect(valueText, new Rect(0, size / 2 - size * 0.13, size, size * 0.26));
  return ctx.getImage();
}

// ================= HEART (Bézier, shaped after SF Symbol heart.fill) =================
// Built in a 100x100 design space, then scaled: plump round lobes, wide body,
// softly rounded bottom point — not the sharp parametric cardioid.
function heartPath(ctx, cx, cy, s) {
  const P = (x, y) => new Point(cx + (x - 50) * s, cy + (y - 50) * s);
  const path = new Path();
  path.move(P(50, 88));
  path.addCurve(P(6, 38), P(30, 72), P(6, 58));   // left side sweeping up
  path.addCurve(P(50, 26), P(6, 11), P(36, 7));   // left lobe over the top into the cleft
  path.addCurve(P(94, 38), P(64, 7), P(94, 11));  // right lobe
  path.addCurve(P(50, 88), P(94, 58), P(70, 72)); // right side down to the point
  path.closeSubpath();
  ctx.addPath(path);
}

function makeHeartImage(bpm, theme, size) {
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const s = size / 108;
  const cx = size / 2, cy = size / 2 + size * 0.02;

  // soft outer glow (cheap blur: oversized low-alpha copies)
  for (let i = 3; i >= 1; i--) {
    heartPath(ctx, cx, cy, s * (1 + i * 0.05));
    ctx.setFillColor(withAlpha(theme.b, 0.06));
    ctx.fillPath();
  }
  // deep blood-red base
  heartPath(ctx, cx, cy, s);
  ctx.setFillColor(theme.a);
  ctx.fillPath();
  // vivid highlight, inset and lifted, for Apple-style depth
  heartPath(ctx, cx, cy - size * 0.045, s * 0.82);
  ctx.setFillColor(withAlpha(theme.b, 0.62));
  ctx.fillPath();

  ctx.setTextAlignedCenter();
  ctx.setFont(uiFont(size * 0.25, true));
  ctx.setTextColor(Color.white());
  ctx.drawTextInRect(bpm != null ? String(bpm) : "—", new Rect(0, cy - size * 0.16, size, size * 0.23));

  // subtle pulse line beneath the number
  const pulse = new Path();
  const py = cy + size * 0.10, w = size * 0.34, x0 = cx - w / 2;
  pulse.move(new Point(x0, py));
  pulse.addLine(new Point(x0 + w * 0.30, py));
  pulse.addLine(new Point(x0 + w * 0.42, py - size * 0.055));
  pulse.addLine(new Point(x0 + w * 0.54, py + size * 0.07));
  pulse.addLine(new Point(x0 + w * 0.66, py));
  pulse.addLine(new Point(x0 + w, py));
  ctx.addPath(pulse);
  ctx.setStrokeColor(withAlpha(Color.white(), 0.7));
  ctx.setLineWidth(1.4);
  ctx.strokePath();

  return ctx.getImage();
}

// ================= CARD LAYOUT =================
function addCard(row, { symbolName, label, iconColor, image, subtitle }) {
  const card = row.addStack();
  card.layoutVertically();
  card.backgroundColor = THEME.cardBg;
  card.cornerRadius = 20;
  card.setPadding(11, 10, 11, 10);
  card.size = new Size(100, 0);
  card.url = REFRESH_URL; // tap to reopen Scriptable and re-run, refreshing all three metrics

  const header = card.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();
  if (symbolName) {
    const symbol = SFSymbol.named(symbolName);
    symbol.applyFont(Font.systemFont(11));
    const icon = header.addImage(symbol.image);
    icon.imageSize = new Size(12, 12);
    icon.tintColor = iconColor;
    header.addSpacer(4);
  }
  const labelText = header.addText(label);
  labelText.font = uiFont(10, true);
  labelText.textColor = THEME.labelGray;

  card.addSpacer(8);
  const img = card.addImage(image);
  img.imageSize = new Size(78, 78);
  card.addSpacer(6);

  const sub = card.addText(subtitle);
  sub.font = uiFont(9.5, false);
  sub.textColor = THEME.labelGray;
  sub.centerAlignText();
}

// ================= BUILD =================
async function build() {
  const w = new ListWidget();
  const gradient = new LinearGradient();
  gradient.colors = [new Color("#000000"), new Color("#1a1a1d")];
  gradient.locations = [0, 1];
  gradient.startPoint = new Point(0, 0);
  gradient.endPoint = new Point(1, 1);
  w.backgroundGradient = gradient;
  w.setPadding(12, 12, 12, 12);

  try {
    const token = await getAccessToken();
    const [battery, steps, hr] = await Promise.all([getBattery(token), getSteps(token), getHeartRate(token)]);

    if (DEBUG && !config.runsInWidget) {
      const debugText = debugLog.join("\n\n===============\n\n");
      Pasteboard.copyString(debugText);
      const a = new Alert();
      a.title = "Debug data copied";
      a.message = "The raw steps/heart-rate API responses are on your clipboard now. Paste them into Notes (or straight back into our chat) and send them over.";
      a.addAction("OK");
      await a.presentAlert();
      Script.complete();
      return w;
    }

    // Flexible spacer (no fixed size) so this only claims leftover space — never forces
    // overflow the way a fixed-height element could.
    w.addSpacer();

    const row = w.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    addCard(row, {
      symbolName: "bolt.fill",
      label: "BATTERY",
      iconColor: THEME.battery.icon,
      image: makeRingImage(battery.level / 100, THEME.battery, null, `${battery.level}%`, 78),
      subtitle: battery.name || "Fitbit",
    });

    row.addSpacer(8);

    const stepPct = steps.total / STEP_GOAL;
    const beatGoal = steps.total >= STEP_GOAL;
    addCard(row, {
      symbolName: beatGoal ? "star.fill" : "figure.walk",
      label: "STEPS",
      iconColor: beatGoal ? THEME.gold.icon : THEME.steps.icon,
      image: makeRingImage(stepPct, THEME.steps, THEME.gold, steps.total.toLocaleString(), 78),
      subtitle: beatGoal
        ? `+${(steps.total - STEP_GOAL).toLocaleString()} over goal`
        : `Goal ${STEP_GOAL.toLocaleString()}`,
    });

    row.addSpacer(8);

    addCard(row, {
      symbolName: "heart.fill",
      label: "HEART RATE",
      iconColor: THEME.heart.icon,
      image: makeHeartImage(hr.bpm, THEME.heart, 78),
      subtitle: "bpm",
    });

    w.addSpacer(6);
    const updated = w.addText(`Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    updated.font = uiFont(9, false);
    updated.textColor = THEME.labelGray;
    updated.centerAlignText();
    w.addSpacer(); // flexible again — balances the flexible spacer above
  } catch (e) {
    const err = w.addText("⚠️ " + e.message);
    err.font = uiFont(11, false);
    err.textColor = Color.red();
  }
  return w;
}

const widget = await build();
// Hint to iOS that this widget would like to refresh again in ~25 minutes. iOS treats this as
// a request, not a guarantee — it still governs actual timing based on battery, how often you
// view this widget, and system-wide budget, so real-world refreshes may land anywhere from
// ~15 minutes to a couple of hours apart. There is no way to force an exact interval.
widget.refreshAfterDate = new Date(Date.now() + 25 * 60 * 1000);
if (config.runsInWidget) { Script.setWidget(widget); } else { await widget.presentMedium(); }
Script.complete();
