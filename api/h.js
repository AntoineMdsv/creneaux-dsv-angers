// Serveur de l'appli Créneaux de livraison (fonction Vercel) : villes livrées par l'agence 49, leur tournée
// et leurs horaires de livraison, dans une base Postgres (Neon). On y entre uniquement par le portail DSV Angers
// (droits Consultation ou Modification).
// Aucun code ni aucune clé dans ce dépôt : tout est réglé dans Vercel.
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f));
// L'ancien code de secours n'ouvre plus l'appli : il reste seulement dans la clé des sessions, pour ne déconnecter personne.
const CODE_ADMIN = process.env.CODE_ADMIN || "";
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const SECRET = crypto.createHash("sha256").update([process.env.SESSION_SECRET || "", DB_URL, CODE_ADMIN].join("|")).digest("hex");
const SESSION_S = 12 * 3600;
// Portail commun : seule façon d'entrer dans l'appli. Adresse du portail et clé partagée, même valeur de CLE_PORTAIL dans tous les projets Vercel.
const PORTAIL_URL = String(process.env.PORTAIL_URL || "").trim().replace(/\/+$/, "");
const CLE_PORTAIL = process.env.CLE_PORTAIL || "";
const PORTAIL_ON = !!PORTAIL_URL && CLE_PORTAIL.length >= 32;
const VERIF_S = 300;
const NIVEAUX = ["consult", "modif"];
const MAX_VILLES = 3000;

let pool;
function db() {
  if (!pool) pool = new pg.Pool({ connectionString: DB_URL, max: 3, connectionTimeoutMillis: 15000, query_timeout: 20000, ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: true } });
  return pool;
}
const q = (text, params) => db().query(text, params);

let ready;
async function init() {
  // Toutes les créations de tables en un seul aller-retour vers la base (démarrage à froid plus court).
  await q([
    `CREATE TABLE IF NOT EXISTS villes (id serial PRIMARY KEY, ville text NOT NULL, cp text NOT NULL, regroupement text NOT NULL DEFAULT '',
    plateforme text NOT NULL DEFAULT 'ANE', tournee int NOT NULL, tournee2 int, plages jsonb NOT NULL DEFAULT '[]', tel boolean NOT NULL DEFAULT false,
    remarque text NOT NULL DEFAULT '', lat double precision, lng double precision, version int NOT NULL DEFAULT 1,
    maj timestamptz NOT NULL DEFAULT now(), maj_par text NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS historique (id bigserial PRIMARY KEY, t timestamptz NOT NULL DEFAULT now(), qui text NOT NULL, texte text NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS jetons (jti text PRIMARY KEY, t timestamptz NOT NULL DEFAULT now())`
  ].join(";\n"));
}

// Session : cookie signé "personne.expiration.signature".
// "~..." = entrée par le portail (personne, droits et session du portail, en JSON), revérifiée auprès du portail toutes les 5 minutes.
// Les anciennes sessions ouvertes avec le code de secours ne sont plus acceptées.
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function makeCookie(pid) {
  const v = `${pid}.${Math.floor(Date.now() / 1000) + SESSION_S}`;
  return `creneaux=${v}.${sign(v)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
const COOKIE_VIDE = "creneaux=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
async function session(req) {
  const m = /(?:^|;\s*)creneaux=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const [pid, exp, sig] = m[1].split(".");
  if (!pid || !sig) return null;
  const good = sign(`${pid}.${exp}`);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  if (pid[0] !== "~" || !PORTAIL_ON) return null;
  let o;
  try { o = JSON.parse(Buffer.from(pid.slice(1), "base64url").toString("utf8")); } catch (_) { return null; }
  // Le jeton vérifié à l'entrée vaut vérification pendant 5 minutes, quelle que soit l'instance Vercel qui répond.
  if (!verifs.has(o.sid) && Number(o.vt) > Date.now() - VERIF_S * 1000 && Number(o.vt) <= Date.now()) verifs.set(o.sid, { t: Number(o.vt), r: o });
  const v = await verifPortail(o.sid);
  if (v === null) return null;
  const x = v || o;
  const niveau = NIVEAUX.includes(x.creneaux) ? x.creneaux : null;
  if (!niveau) return null;
  return { id: x.id, nom: x.nom, admin: !!x.admin, niveau, portail: true };
}
// Jeton envoyé par le portail à l'ouverture : signé avec CLE_PORTAIL, valable 1 minute, pour cette appli seulement.
const signP = s => crypto.createHmac("sha256", CLE_PORTAIL).update(s).digest("base64url");
function lireJeton(j) {
  const [b, sig] = String(j || "").split(".");
  if (!PORTAIL_ON || !b || !sig) return null;
  const good = signP("jeton." + b);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  let o;
  try { o = JSON.parse(Buffer.from(b, "base64url").toString("utf8")); } catch (_) { return null; }
  return o && o.app === "creneaux" && o.exp > Date.now() / 1000 && NIVEAUX.includes(o.creneaux) && typeof o.sid === "string" && typeof o.jti === "string" ? o : null;
}
// Le portail est redemandé au plus toutes les 5 minutes par session : session terminée ou droit retiré = accès coupé.
// S'il ne répond pas, on garde sa dernière réponse (ou les droits du jeton) pour ne bloquer personne.
const verifs = new Map();
async function verifPortail(sid) {
  const c = verifs.get(sid);
  if (c && Date.now() - c.t < VERIF_S * 1000) return c.r;
  try {
    const r = await fetch(PORTAIL_URL + "/api/verif", { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { Authorization: "Bearer " + CLE_PORTAIL, "Content-Type": "application/json" }, body: JSON.stringify({ sid, app: "creneaux" }) });
    if (r.status === 200 || r.status === 403) {
      const v = r.status === 200 ? await r.json() : null;
      if (verifs.size > 500) verifs.clear();
      verifs.set(sid, { t: Date.now(), r: v });
      return v;
    }
  } catch (_) {}
  return c ? c.r : undefined;
}

const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const hm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}h${String(m % 60).padStart(2, "0")}`;
const creneauTexte = v => v.tel ? "Tél. conducteur" : v.plages.map(([a, b]) => `${hm(a)}-${hm(b)}`).join(" / ") || "aucun";
const tourneeTexte = v => v.tournee2 ? `${v.tournee} ou ${v.tournee2}` : String(v.tournee);
// Contrôle d'une ville envoyée par la page : renvoie la ville propre, ou un message d'erreur.
function villeValide(o) {
  if (!o || typeof o !== "object") return "Données illisibles";
  const v = { ville: clean(o.ville, 80).toUpperCase(), cp: clean(o.cp, 5), regroupement: clean(o.regroupement, 80).toUpperCase(),
    plateforme: clean(o.plateforme || "ANE", 10).toUpperCase(), tournee: +o.tournee, tournee2: o.tournee2 ? +o.tournee2 : null,
    tel: !!o.tel, remarque: clean(o.remarque, 200), lat: o.lat == null || o.lat === "" ? null : +o.lat, lng: o.lng == null || o.lng === "" ? null : +o.lng, plages: [] };
  if (!v.ville) return "Indique le nom de la ville";
  if (!/^\d{5}$/.test(v.cp)) return "Le code postal doit avoir 5 chiffres";
  if (!Number.isInteger(v.tournee) || v.tournee < 1 || v.tournee > 999) return "Choisis une tournée";
  if (v.tournee2 != null && (!Number.isInteger(v.tournee2) || v.tournee2 < 1 || v.tournee2 > 999 || v.tournee2 === v.tournee)) v.tournee2 = null;
  if (v.lat != null && !(Number.isFinite(v.lat) && Math.abs(v.lat) <= 90 && Number.isFinite(v.lng) && Math.abs(v.lng) <= 180)) v.lat = v.lng = null;
  if (v.lat == null) v.lng = null;
  if (!v.tel) {
    const pl = Array.isArray(o.plages) ? o.plages.slice(0, 3) : [];
    for (const p of pl) {
      const a = Array.isArray(p) ? Math.round(+p[0]) : NaN, b = Array.isArray(p) ? Math.round(+p[1]) : NaN;
      if (!(a >= 0 && b <= 24 * 60 && b > a)) return "Une plage horaire est incorrecte : la fin doit être après le début";
      v.plages.push([a, b]);
    }
    v.plages.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < v.plages.length; i++) if (v.plages[i][0] < v.plages[i - 1][1]) return "Les plages horaires se chevauchent";
    if (!v.plages.length) return "Indique au moins une plage horaire, ou « Tél. conducteur »";
  }
  return v;
}
const COLS = ["ville", "cp", "regroupement", "plateforme", "tournee", "tournee2", "plages", "tel", "remarque", "lat", "lng"];
const vals = v => COLS.map(k => k === "plages" ? JSON.stringify(v.plages) : v[k]);
const SELECT = `SELECT id, ville, cp, regroupement, plateforme, tournee, tournee2, plages, tel, remarque, lat, lng, version, maj, maj_par FROM villes`;
// Ce qui a changé entre deux versions d'une ville, en mots, pour l'historique.
function changements(a, b) {
  const ch = [];
  if (a.ville !== b.ville) ch.push(`renommée en ${b.ville}`);
  if (a.cp !== b.cp) ch.push(`CP ${b.cp} (avant : ${a.cp})`);
  if (a.regroupement !== b.regroupement) ch.push(`regroupement ${b.regroupement || "aucun"} (avant : ${a.regroupement || "aucun"})`);
  if (tourneeTexte(a) !== tourneeTexte(b)) ch.push(`tournée ${tourneeTexte(b)} (avant : ${tourneeTexte(a)})`);
  if (creneauTexte(a) !== creneauTexte(b)) ch.push(`créneau ${creneauTexte(b)} (avant : ${creneauTexte(a)})`);
  if (a.remarque !== b.remarque) ch.push(b.remarque ? `remarque « ${b.remarque} »` : "remarque retirée");
  if (a.lat !== b.lat || a.lng !== b.lng) ch.push("position sur la carte corrigée");
  return ch;
}

function send(res, status, type, body, cookie) {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  if (type.startsWith("text/html")) res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  if (cookie) res.setHeader("Set-Cookie", cookie);
  res.end(body);
}
const json = (res, status, o, cookie) => send(res, status, "application/json; charset=utf-8", JSON.stringify(o), cookie);
const text = (res, status, t) => send(res, status, "text/plain; charset=utf-8", t);
async function body(req, limit = 64 * 1024) {
  // Vercel peut avoir déjà lu le corps de la requête : on le reprend alors tel quel.
  let pre;
  try { pre = req.body; } catch (_) {}
  if (pre != null && pre !== "") {
    const b = Buffer.isBuffer(pre) ? pre : Buffer.from(typeof pre === "string" ? pre : JSON.stringify(pre));
    if (b.length > limit) throw new Error("trop gros");
    return b;
  }
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error("trop gros"); parts.push(c); }
  return Buffer.concat(parts);
}
const jsonBody = async (req, limit) => { try { return JSON.parse((await body(req, limit)).toString("utf8")); } catch (_) { return undefined; } };
const log = (qui, texte) => q(`INSERT INTO historique (qui, texte) VALUES ($1, $2)`, [qui, texte.slice(0, 600)]);
// Plus de page de connexion propre à l'appli : sans session, on est renvoyé vers le portail.
function versPortail(res) {
  if (!PORTAIL_ON) return text(res, 503, "Entrée uniquement par le portail : réglez PORTAIL_URL et CLE_PORTAIL (32 caractères minimum) dans Vercel, puis Redeploy.");
  res.statusCode = 302; res.setHeader("Cache-Control", "no-store"); res.setHeader("Location", PORTAIL_URL + "/"); return res.end();
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  // Vercel transmet le chemin réécrit dans ?p= ; à défaut, on le reprend de l'adresse d'origine.
  let p = url.searchParams.get("p");
  if (p == null) p = url.pathname === "/" || url.pathname === "/index.html" ? "page" : url.pathname.replace(/^\/(api\/)?/, "");
  p = "/" + String(p).replace(/^\/+/, "");
  const method = req.method;
  let m;
  try {
    if (p === "/health") {
      if (!DB_URL) return json(res, 500, { ok: false, base: "absente : reliez une base Neon au projet (onglet Storage), puis Redeploy" });
      try { const t = Date.now(); await q("SELECT 1"); return json(res, 200, { ok: true, base: "connectée", ms: Date.now() - t, portail: PORTAIL_ON }); }
      catch (e) { return json(res, 500, { ok: false, base: "erreur", detail: String(e.message || e).slice(0, 200) }); }
    }
    if (!DB_URL) return text(res, 500, "Base de données non configurée : ajoutez une base Neon au projet Vercel.");
    if (!ready) ready = init().catch(e => { ready = null; throw e; });
    await ready;

    // Une écriture doit venir de la page de l'appli elle-même.
    if (["PUT", "POST", "DELETE"].includes(method)) {
      const o = req.headers.origin;
      if (o && o !== `https://${req.headers.host}` && o !== `http://${req.headers.host}`) return text(res, 403, "Origine refusée");
    }
    // Ancienne adresse de la page de connexion (favoris) : renvoie vers le portail.
    if (p === "/connexion") return versPortail(res);
    // Arrivée depuis le portail : le jeton ouvre une session de 12 h au nom de la personne.
    if (p === "/portail" && method === "GET") {
      const o = lireJeton(url.searchParams.get("jeton"));
      if (!o || !(await q(`WITH d AS (DELETE FROM jetons WHERE t < now() - interval '10 minutes') INSERT INTO jetons (jti) VALUES ($1) ON CONFLICT DO NOTHING`, [o.jti])).rowCount) {
        return versPortail(res);
      }
      // vt : heure de la dernière vérification (le jeton vient d'être vérifié), pour ne pas redemander au portail avant 5 minutes.
      const moi = { id: String(o.id).slice(0, 40), nom: clean(o.nom, 40), admin: !!o.admin, creneaux: o.creneaux, sid: o.sid };
      const pid = "~" + Buffer.from(JSON.stringify({ ...moi, vt: Date.now() })).toString("base64url");
      verifs.set(o.sid, { t: Date.now(), r: moi });
      // Page relais plutôt qu'une redirection : le cookie SameSite=Strict n'est envoyé qu'une fois sur le site lui-même.
      return send(res, 200, "text/html; charset=utf-8", `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f5f8;font:600 15px Barlow,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f2a5c}div{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #d5dbe5;border-radius:10px;padding:16px 22px;box-shadow:0 10px 30px rgb(15 42 92 / .14)}i{width:22px;height:22px;border-radius:50%;border:3px solid #d5dbe5;border-top-color:#2F80D8;animation:t .8s linear infinite}@keyframes t{to{transform:rotate(360deg)}}a{color:inherit;text-decoration:none}</style><title>Créneaux DSV Angers</title><div role="status"><i></i><a href="/">Ouverture des créneaux…</a></div><script>location.replace("/")</script>`, makeCookie(pid));
    }
    if (p === "/logout") return json(res, 200, { ok: true }, COOKIE_VIDE);

    const ses = await session(req);
    if (!ses) {
      if (p === "/page") return versPortail(res);
      return text(res, 401, "Connexion requise");
    }
    if (p === "/page") return send(res, 200, "text/html; charset=utf-8", read("pages/index.html"));
    if (p === "/moi" && method === "GET")
      return json(res, 200, { nom: ses.nom, admin: ses.admin, niveau: ses.niveau, portail: PORTAIL_ON ? PORTAIL_URL : "", viaPortail: !!ses.portail });

    if (p === "/villes" && method === "GET") return json(res, 200, (await q(`${SELECT} ORDER BY tournee, ville`)).rows);
    if (p === "/historique" && method === "GET") {
      if (!ses.admin) return text(res, 403, "Réservé aux administrateurs");
      return json(res, 200, (await q(`SELECT t, qui, texte FROM historique ORDER BY t DESC, id DESC LIMIT 200`)).rows);
    }

    // Tout le reste modifie : il faut le droit Modification.
    const modif = ses.niveau === "modif";
    if (p === "/villes" && method === "POST") {
      if (!modif) return text(res, 403, "Vous êtes en consultation : demandez le droit Modification dans le portail");
      const v = villeValide(await jsonBody(req, 8000));
      if (typeof v === "string") return text(res, 400, v);
      if ((await q(`SELECT count(*)::int AS n FROM villes`)).rows[0].n >= MAX_VILLES) return text(res, 400, "Trop de villes");
      const r = (await q(`INSERT INTO villes (${COLS.join(", ")}, maj_par) VALUES (${COLS.map((_, i) => "$" + (i + 1)).join(", ")}, $${COLS.length + 1}) RETURNING id`, [...vals(v), ses.nom])).rows[0];
      await log(ses.nom, `${v.ville} (${v.cp}) ajoutée : tournée ${tourneeTexte(v)}, créneau ${creneauTexte(v)}`);
      return json(res, 200, (await q(`${SELECT} WHERE id = $1`, [r.id])).rows[0]);
    }
    if ((m = /^\/villes\/(\d{1,9})$/.exec(p))) {
      if (!modif) return text(res, 403, "Vous êtes en consultation : demandez le droit Modification dans le portail");
      const id = +m[1];
      const cur = (await q(`${SELECT} WHERE id = $1`, [id])).rows[0];
      if (!cur) return text(res, 404, "Cette ville n'existe plus (supprimée entre-temps)");
      if (method === "PUT") {
        const o = await jsonBody(req, 8000);
        const v = villeValide(o);
        if (typeof v === "string") return text(res, 400, v);
        // Si quelqu'un a modifié la ville pendant ce temps, on ne l'écrase pas.
        if (o.version !== cur.version) return json(res, 409, { conflit: true, ville: cur });
        const ch = changements(cur, v);
        const r = (await q(`UPDATE villes SET ${COLS.map((k, i) => `${k} = $${i + 2}`).join(", ")}, version = version + 1, maj = now(), maj_par = $${COLS.length + 2}
          WHERE id = $1 AND version = $${COLS.length + 3} RETURNING id`, [id, ...vals(v), ses.nom, cur.version])).rows[0];
        if (!r) return json(res, 409, { conflit: true, ville: (await q(`${SELECT} WHERE id = $1`, [id])).rows[0] });
        if (ch.length) await log(ses.nom, `${cur.ville} : ${ch.join(", ")}`);
        return json(res, 200, (await q(`${SELECT} WHERE id = $1`, [id])).rows[0]);
      }
      if (method === "DELETE") {
        await q(`DELETE FROM villes WHERE id = $1`, [id]);
        await log(ses.nom, `${cur.ville} (${cur.cp}) supprimée : tournée ${tourneeTexte(cur)}, créneau ${creneauTexte(cur)}`);
        return json(res, 200, { ok: true });
      }
      return text(res, 405, "Méthode non autorisée");
    }

    // Reprise du fichier Excel (lu dans la page) : remplace toute la liste. Réservé aux administrateurs.
    if (p === "/import" && method === "POST") {
      if (!ses.admin) return text(res, 403, "Réservé aux administrateurs");
      const o = await jsonBody(req, 2 * 1024 * 1024) || {};
      const rows = Array.isArray(o.villes) ? o.villes : [];
      if (!rows.length) return text(res, 400, "Aucune ville trouvée dans le fichier");
      if (rows.length > MAX_VILLES) return text(res, 400, "Trop de lignes dans le fichier");
      const ok = [], refus = [];
      rows.forEach((r, i) => { const v = villeValide(r); if (typeof v === "string") refus.push(`Ligne ${i + 2} (${clean(r && r.ville, 40) || "sans nom"}) : ${v}`); else ok.push(v); });
      if (!ok.length) return json(res, 400, { refus });
      const client = await db().connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM villes`);
        for (let i = 0; i < ok.length; i += 200) {
          const part = ok.slice(i, i + 200), params = [];
          const rowsSql = part.map(v => { const base = params.length; params.push(...vals(v), ses.nom); return `(${COLS.map((_, j) => "$" + (base + j + 1)).join(", ")}, $${base + COLS.length + 1})`; });
          await client.query(`INSERT INTO villes (${COLS.join(", ")}, maj_par) VALUES ${rowsSql.join(", ")}`, params);
        }
        await client.query(`INSERT INTO historique (qui, texte) VALUES ($1, $2)`, [ses.nom, `Reprise du fichier ${clean(o.fichier, 80) || "Excel"} : ${ok.length} villes${refus.length ? `, ${refus.length} lignes écartées` : ""}`]);
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
      return json(res, 200, { ok: true, n: ok.length, refus });
    }
    return text(res, 404, "Introuvable");
  } catch (e) {
    console.error(e);
    return text(res, 500, "Erreur serveur : " + String(e.message || e).slice(0, 160));
  }
}
