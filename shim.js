// Runs the tracker outside claude.ai: Firebase for sign-in + storage, Gemini for the AI.
// It provides the same window.claude.use(...) the page was written against.
(() => {
  window.STEP1_SITE = true;
  const DOMAIN = "step1-tracker.app";
  const ADMIN = String(window.ADMIN_USERNAME || "").toLowerCase();
  const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
  firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth(), fs = firebase.firestore();
  try { fs.settings({ignoreUndefinedProperties: true, merge: true}); } catch {}

  // ---------- small UI helpers ----------
  const css = document.createElement("style");
  css.textContent = `
  .s1-gate{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--bg,#eef3f2) 92%,transparent);backdrop-filter:blur(6px)}
  .s1-box{width:min(400px,100%);background:var(--surface,#fff);border:1px solid var(--border,#d6e0de);border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.15);font-family:var(--body,system-ui)}
  .s1-box h2{margin:0 0 4px;font-family:var(--display,inherit);font-size:24px}
  .s1-box p{margin:0 0 14px;color:var(--muted,#5b6b68);line-height:1.6}
  .s1-box label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}
  .s1-box input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid var(--border,#cfd9d7);font-size:16px;background:var(--bg,#fff);color:inherit}
  .s1-box .s1-row{display:flex;gap:8px;margin-top:16px}
  .s1-box button{flex:1;padding:11px 12px;border-radius:10px;border:1px solid var(--border,#cfd9d7);background:var(--surface,#fff);font-weight:700;font-size:15px;cursor:pointer;color:inherit}
  .s1-box button.pri{background:var(--accent,#0f766e);border-color:var(--accent,#0f766e);color:#fff}
  .s1-box .s1-err{color:#b42318;min-height:20px;margin-top:8px;font-size:14px}
  .s1-box .s1-ar{direction:rtl;font-family:var(--arabic,inherit)}
  .s1-acct{position:fixed;left:12px;bottom:12px;z-index:50;display:flex;gap:6px}
  .s1-acct button{padding:6px 10px;border-radius:999px;border:1px solid var(--border,#cfd9d7);background:var(--surface,#fff);font-size:12px;cursor:pointer;color:inherit}`;
  document.head.appendChild(css);
  const bodyReady = () => document.body ? Promise.resolve() : new Promise(r => addEventListener("DOMContentLoaded", r, {once: true}));
  const el = html => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; };

  // ---------- sign in with a username + PIN ----------
  const cleanUser = u => String(u || "").trim().toLowerCase();
  const emailOf = u => `${u}@${DOMAIN}`;
  const passOf = pin => `${pin}::s1`;
  const userOf = fu => (fu && fu.email ? fu.email.split("@")[0] : "");
  function signInGate(){
    return bodyReady().then(() => new Promise(done => {
      const g = el(`<div class="s1-gate"><form class="s1-box" autocomplete="on">
        <h2>Step 1 Tracker</h2>
        <p class="s1-ar">أهلاً بيك 👋 ادخل باسم المستخدم والكود السري. أول مرة؟ اختار اسم وكود ودوس <b>حساب جديد</b>.</p>
        <label for="s1u">Username (English letters/numbers)</label>
        <input id="s1u" name="username" autocomplete="username" placeholder="e.g. ahmed" required>
        <label for="s1p">Secret code (4–8 digits)</label>
        <input id="s1p" name="password" type="password" inputmode="numeric" autocomplete="current-password" placeholder="••••" required>
        <div class="s1-err" id="s1e" role="alert"></div>
        <div class="s1-row"><button type="button" id="s1new">حساب جديد</button><button type="submit" class="pri">Sign in</button></div>
      </form></div>`);
      document.body.appendChild(g);
      const err = t => g.querySelector("#s1e").textContent = t;
      const go = async mode => {
        const u = cleanUser(g.querySelector("#s1u").value), pin = g.querySelector("#s1p").value.trim();
        if (!/^[a-z0-9_.]{3,20}$/.test(u)) return err("Username: 3–20 English letters, numbers, _ or .");
        if (!/^\d{4,8}$/.test(pin)) return err("الكود لازم يكون من 4 لـ 8 أرقام");
        err("…");
        try {
          if (mode === "new") await auth.createUserWithEmailAndPassword(emailOf(u), passOf(pin));
          else await auth.signInWithEmailAndPassword(emailOf(u), passOf(pin));
          g.remove(); done(auth.currentUser);
        } catch (e) {
          const c = e && e.code || "";
          err(c.includes("email-already-in-use") ? "الاسم ده مستخدم. اختار اسم تاني أو ادخل بيه لو بتاعك."
            : c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found") ? "الاسم أو الكود غلط. لو أول مرة دوس حساب جديد."
            : c.includes("too-many-requests") ? "محاولات كتير. استنى شوية وجرّب تاني."
            : c.includes("network") ? "مفيش نت. جرّب تاني." : "حصلت مشكلة: " + c);
        }
      };
      g.querySelector("form").addEventListener("submit", e => { e.preventDefault(); go("in"); });
      g.querySelector("#s1new").addEventListener("click", () => go("new"));
      g.querySelector("#s1u").focus();
    }));
  }
  const ready = new Promise(res => {
    const off = auth.onAuthStateChanged(async fu => { off(); res(fu || await signInGate()); });
  });

  // ---------- Firestore, shaped like the page's db ----------
  // Firestore can't store an array inside an array, so those are wrapped as {__a:[...]}
  const enc = (v, inArr) => {
    if (Array.isArray(v)){ const a = v.map(x => enc(x, true)); return inArr ? {__a: a} : a; }
    if (v && typeof v === "object" && !(v instanceof Date)){ const o = {}; for (const k in v) if (v[k] !== undefined) o[k] = enc(v[k], false); return o; }
    return v;
  };
  const dec = v => {
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === "object"){ const ks = Object.keys(v); if (ks.length === 1 && ks[0] === "__a" && Array.isArray(v.__a)) return v.__a.map(dec); const o = {}; for (const k of ks) o[k] = dec(v[k]); return o; }
    return v;
  };
  const snap = s => ({id: s.id, exists: s.exists, data: () => dec(s.data() || null)});
  const errOf = e => ({code: e && e.code === "permission-denied" ? "permission_denied" : (e && e.code) || "failed", message: e && e.message});
  const wrapP = p => p.catch(e => { throw errOf(e); });
  const db = {
    doc: path => { const r = fs.doc(path); return {
      get: () => wrapP(r.get().then(snap)),
      set: v => wrapP(r.set(enc(v))),
      update: v => wrapP(r.update(enc(v))),
      delete: () => wrapP(r.delete()),
      onSnapshot: (n, e) => r.onSnapshot(s => n(snap(s)), x => e && e(errOf(x)))
    }; },
    collection: path => ({
      onSnapshot: (n, e) => fs.collection(path).onSnapshot(q => { const docs = q.docs.map(snap); n({docs, size: docs.length, empty: !docs.length}); }, x => e && e(errOf(x)))
    })
  };

  // ---------- who is this ----------
  const isAdminUser = fu => !!ADMIN && userOf(fu) === ADMIN;
  const user = {
    isOwner: async () => isAdminUser(await ready),
    canEdit: async () => isAdminUser(await ready),
    can: async () => true,
    id: async () => (await ready).uid,
    me: async () => { const fu = await ready; const u = userOf(fu); return {id: fu.uid, name: u ? u[0].toUpperCase() + u.slice(1) : "", email: null}; },
    profiles: async ids => Object.fromEntries((ids || []).map(id => [id, {id, name: ""}]))
  };

  // ---------- Gemini ----------
  let cfgP = null;
  const aiConfig = () => cfgP || (cfgP = ready.then(() => fs.doc("shared/config").get()).then(s => s.exists ? s.data() : {}).catch(() => ({})));
  const SYSTEM = `You are the AI inside a USMLE Step 1 study tracker used by Egyptian medical students.
Follow the formatting instructions in each request EXACTLY:
- When asked for a fenced block (\`\`\`setup, \`\`\`plan-ops, \`\`\`meta, \`\`\`question, \`\`\`cards, \`\`\`flow, \`\`\`quiz or any other), write it with exactly that tag, and put valid JSON inside when JSON is asked for (double quotes, no comments, no trailing commas).
- When asked for JSON only, output only the JSON.
- No preamble ("Sure!", "Of course"), no closing offers, no mention of being an AI.
- When asked for Egyptian Arabic, write natural Egyptian colloquial (عامية مصرية), not formal فصحى. Keep medical terms in English. Never put English words or numbers inside brackets.
- Be short and clear. Do not invent facts, numbers or dates; if something is unknown, say so or use the default the request gives.
- Use Markdown headings and bullets only as the request describes; no tables unless asked.`;
  const b64 = blob => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = bad; r.readAsDataURL(blob); });
  async function gemini(input, opts = {}, json = false){
    const cfg = await aiConfig();
    if (!cfg.geminiKey) throw {code: "not_granted", message: "The admin hasn't added the Gemini key yet."};
    const turns = typeof input === "string" ? [{role: "user", content: input}] : input;
    const contents = turns.map(t => ({role: t.role === "assistant" ? "model" : "user", parts: [{text: String(t.content || "")}]}));
    const imgs = (opts.images || []).slice(0, 6);
    if (imgs.length){ const last = contents[contents.length - 1]; for (const im of imgs) last.parts.push({inline_data: {mime_type: im.type || "image/png", data: await b64(im)}}); }
    const gen = {temperature: json ? 0.2 : 0.5, maxOutputTokens: 8192, ...(json ? {responseMimeType: "application/json"} : {})};
    const models = [...new Set([cfg.model, ...MODELS].filter(Boolean))];
    let lastErr;
    for (const m of models){
      let res;
      try {
        // gemini 3 models think by default; keep it light so answers come fast
        const body = {systemInstruction: {parts: [{text: SYSTEM}]}, contents, generationConfig: /^gemini-3/.test(m) && !/lite/.test(m) ? {...gen, thinkingConfig: {thinkingLevel: opts.modelTier === "complex" ? "high" : "low"}} : gen};
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.geminiKey)}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal: opts.signal});
      } catch (e) { if (e && e.name === "AbortError") throw {code: "aborted"}; throw {code: "network", message: "No connection"}; }
      if (res.status === 404 || res.status === 503 || res.status === 500){ lastErr = res.status === 404 ? {code: "model_not_found", message: m} : {code: "busy", message: "Gemini عليه ضغط دلوقتي. جرّب تاني كمان شوية."}; continue; }
      if (res.status === 429) throw {code: "rate_limited", message: "وصلنا للحد المجاني بتاع Gemini. استنى دقيقة وجرّب تاني."};
      if (!res.ok){ let t = ""; try { t = (await res.json()).error.message; } catch {} throw {code: res.status === 400 || res.status === 403 ? "bad_key" : "failed", message: t || ("HTTP " + res.status)}; }
      const rd = res.body.getReader(), td = new TextDecoder(); let buf = "", text = "", finish = "";
      for (;;){
        const {value, done} = await rd.read(); if (done) break;
        buf += td.decode(value, {stream: true});
        let i; while ((i = buf.indexOf("\n")) >= 0){
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
          const c = j.candidates && j.candidates[0]; if (!c) continue;
          const add = ((c.content && c.content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("");
          if (add){ text += add; opts.onText && opts.onText({text, delta: add}); }
          if (c.finishReason) finish = c.finishReason;
        }
      }
      return {text, truncated: finish === "MAX_TOKENS"};
    }
    throw lastErr || {code: "failed"};
  }
  const sample = (input, opts) => gemini(input, opts, false);
  sample.json = async (input, opts) => {
    const {text} = await gemini(input, opts, true);
    const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(t); } catch { const m = t.match(/[\[{][\s\S]*[\]}]/); if (m) return JSON.parse(m[0]); throw {code: "bad_json", message: "The AI answer wasn't valid JSON"}; }
  };
  sample.limits = async () => ({images: true});

  // ---------- file downloads ----------
  const downloads = {save: async ({filename, data}) => {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename || "download";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return {saved: true};
  }};

  // ---------- admin: first run (import old data) + the Gemini key ----------
  function adminImportGate(){
    return bodyReady().then(() => new Promise(done => {
      const g = el(`<div class="s1-gate"><div class="s1-box s1-ar">
        <h2>أهلاً يا أدمن 👋</h2>
        <p>لو معاك ملف <b>backup-admin.json</b> من الموقع القديم، اختاره وهنقل خطتك وأخطاءك ونوتسك وشاتاتك. أو ابدأ من الأول.</p>
        <input type="file" id="s1f" accept=".json,application/json">
        <div class="s1-err" id="s1e" role="alert"></div>
        <div class="s1-row"><button type="button" id="s1skip">ابدأ من الأول</button><button type="button" class="pri" id="s1imp">Import</button></div>
      </div></div>`);
      document.body.appendChild(g);
      const err = t => g.querySelector("#s1e").textContent = t;
      g.querySelector("#s1skip").onclick = () => { g.remove(); done(); };
      g.querySelector("#s1imp").onclick = async () => {
        const f = g.querySelector("#s1f").files[0]; if (!f) return err("اختار الملف الأول");
        try {
          const data = JSON.parse(await f.text()), keys = Object.keys(data).filter(k => /^[a-z_]+\/[^/]+$/.test(k));
          err(`بنقل ${keys.length} حاجة…`);
          for (let i = 0; i < keys.length; i += 400){ const b = fs.batch(); keys.slice(i, i + 400).forEach(k => b.set(fs.doc(k), enc(data[k]))); await b.commit(); }
          g.remove(); done();
        } catch (e) { err("الملف ده مش مظبوط: " + (e.message || e.code || e)); }
      };
    }));
  }
  function keyGate(cur){
    return bodyReady().then(() => new Promise(done => {
      const g = el(`<div class="s1-gate"><div class="s1-box s1-ar">
        <h2>مفتاح Gemini 🔑</h2>
        <p>اعمل مفتاح مجاني من <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> والزقه هنا. هيستخدمه كل الأعضاء، ومش بيتحط في كود الموقع.</p>
        <input id="s1k" dir="ltr" placeholder="AIza… / AQ.…" value="${cur ? cur.replace(/"/g, "") : ""}">
        <div class="s1-err" id="s1e" role="alert"></div>
        <div class="s1-row"><button type="button" id="s1later">بعدين</button><button type="button" class="pri" id="s1save">Save</button></div>
      </div></div>`);
      document.body.appendChild(g);
      const err = t => g.querySelector("#s1e").textContent = t;
      g.querySelector("#s1later").onclick = () => { g.remove(); done(); };
      g.querySelector("#s1save").onclick = async () => {
        const k = g.querySelector("#s1k").value.trim(); if (!/^[\w.-]{20,}$/.test(k)) return err("ده مش شكل مفتاح Gemini");
        err("بجرّبه…");
        const t = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`).catch(() => null);
        if (!t || !t.ok) return err("المفتاح ده مش شغال. اتأكد إنك نسخته كامل.");
        await fs.doc("shared/config").set({geminiKey: k}, {merge: true}); cfgP = null; g.remove(); done();
      };
    }));
  }
  const adminReady = ready.then(async fu => {
    if (!isAdminUser(fu)) return;
    try { if (!(await fs.doc("plan/lectures").get()).exists) await adminImportGate(); } catch (e) { console.error(e); }
    const cfg = await aiConfig(); if (!cfg.geminiKey) await keyGate("");
  });

  // ---------- account buttons ----------
  ready.then(async fu => {
    await bodyReady();
    const bar = el(`<div class="s1-acct"><span style="display:none"></span><button type="button" title="Sign out">⎋ ${userOf(fu)} · Sign out</button></div>`);
    bar.querySelector("button").onclick = () => auth.signOut().then(() => location.reload());
    if (isAdminUser(fu)){ const k = el(`<button type="button" title="Gemini key">🔑 AI key</button>`); k.onclick = async () => { await keyGate((await aiConfig()).geminiKey || ""); }; bar.appendChild(k); }
    document.body.appendChild(bar);
  });

  const caps = {db, user, sample, downloads};
  window.claude = {use: async name => {
    if (!(name in caps)) return null;
    await ready; if (name === "db") await adminReady;
    return caps[name];
  }};
})();
