"use client";

// app/saldiri/page.tsx
// -----------------------------------------------------------------------------
// SALDIRI PANELİ — prompt injection ölçüm arayüzü.
//
// Amaç: 5 saldırı ailesi × 2 koşul (savunmasız/savunmalı) × N koşuyu TEK tıkla
// çalıştırıp ham metrik tablosunu ve özet tablosunu basmak. Ayrıca payload'suz
// "temiz referans" koşuları da otomatik alınır; karşılaştırma ona göre yapılır.
//
// TASARIM İLKELERİ:
//   - Deney modunun (app/deney) tek-değişkenli yapısına DOKUNMAZ; ortak kodu
//     (prompt, cost, istemciAkis, olcum) paylaşır ama ayrı bir sayfadır.
//   - Koşular SIRAYLA çalışır (paralel değil; rate limit yememek için).
//   - Çalıştırmadan ÖNCE tahmini maliyet gösterilip onay istenir.
//   - İptal edilebilir (AbortController).
//   - Başarı kriteri OTOMATİK YORUMLANMAZ: tablo ham hâliyle basılır; "saldırı
//     başarılı" etiketini kullanıcı elle koyar. Panel yalnızca "temiz referanstan
//     değişiklik gözlendi mi" gibi mekanik bir kıyas verir.
// -----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { ORNEKLER } from "@/lib/ornekler";
import {
  FIYATLAR,
  maliyetHesapla,
  kabaTokenTahmini,
  type ModelAdi,
} from "@/lib/cost";
import { sistemPromptu, sozlesmeMetniniSar } from "@/lib/prompt";
import { SALDIRILAR, payloadGom } from "@/lib/saldirilar";
import { analiziCalistir } from "@/lib/istemciAkis";
import {
  metrikCikar,
  ozetHesapla,
  referansProfil,
  riskImzasi,
  csvUret,
  markdownUret,
  type KosuMetrik,
} from "@/lib/olcum";

// Temiz (payload'suz) referans metin. Bu, test/hizmet_sozlesmesi.txt ile BİREBİR
// AYNI içeriktir (lib/ornekler.ts içindeki "detayli" örneğinde aynen tutulur);
// böylece istemcide dosya okumaya gerek kalmaz.
const TEMIZ_METIN =
  ORNEKLER.find((o) => o.id === "detayli")?.metin ?? ORNEKLER[0].metin;

// Payload'lar burada saklanır (sayfa yenilense de kaybolmasın).
const LS_KEY = "saldiri_payloadlari";

// Maliyet ÖN tahmininde varsayacağımız kaba completion token sayısı. Gerçek
// değer koşu bitince ölçülür; bu yalnızca onay öncesi ALT SINIR tahmini içindir.
const TAHMINI_COMPLETION_TOKEN = 1200;

// Client tarafı "bugün" (YYYY-MM-DD). Yalnızca handler içinde çağrılır.
function bugunBul(): string {
  return new Date().toISOString().slice(0, 10);
}

// Bir koşu planı öğesi: hangi saldırı, hangi koşul, kaçıncı koşu, hangi metin.
type PlanOgesi = {
  saldiriId: string;
  saldiriAd: string;
  savunma: boolean;
  kosuNo: number;
  metin: string;
};

export default function SaldiriSayfasi() {
  // Payload metinleri (id -> metin). Başlangıç: SALDIRILAR varsayılanları.
  const [payloadlar, setPayloadlar] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const s of SALDIRILAR) o[s.id] = s.payload;
    return o;
  });

  const [model, setModel] = useState<ModelAdi>("gpt-4.1");
  const [tekrar, setTekrar] = useState(3);
  const [moderasyon, setModerasyon] = useState(false);

  const [calisiyor, setCalisiyor] = useState(false);
  const [ilerleme, setIlerleme] = useState<{ mevcut: number; toplam: number } | null>(
    null
  );
  const [metrikler, setMetrikler] = useState<KosuMetrik[]>([]);
  const [hata, setHata] = useState<string | null>(null);
  const [kopyalandi, setKopyalandi] = useState(false);

  // Onay bekleyen çalıştırma (tahmini maliyet gösterilir, kullanıcı onaylar).
  const [onayBekleyen, setOnayBekleyen] = useState<{
    plan: PlanOgesi[];
    cagri: number;
    usd: number;
    aktifSaldiri: number;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // localStorage'dan payload'ları yükle (mount sonrası; SSR uyuşmazlığı olmasın).
  useEffect(() => {
    try {
      const ham = localStorage.getItem(LS_KEY);
      if (!ham) return;
      const kayit = JSON.parse(ham) as Record<string, string>;
      setPayloadlar((mevcut) => {
        const yeni = { ...mevcut };
        for (const s of SALDIRILAR) {
          if (typeof kayit[s.id] === "string") yeni[s.id] = kayit[s.id];
        }
        return yeni;
      });
    } catch {
      /* bozuk kayıt varsa yut */
    }
  }, []);

  function payloadGuncelle(id: string, deger: string) {
    setPayloadlar((mevcut) => {
      const yeni = { ...mevcut, [id]: deger };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(yeni));
      } catch {
        /* localStorage kapalıysa yut */
      }
      return yeni;
    });
  }

  // N'yi makul aralığa sıkıştır (1..20).
  const n = Math.max(1, Math.min(20, Math.floor(tekrar) || 1));

  // Koşu planını kur: önce temiz referans (2 koşul × N), sonra dolu payload'lu
  // her saldırı (2 koşul × N). Sıra korunur.
  function planYap(): PlanOgesi[] {
    const plan: PlanOgesi[] = [];
    for (const sav of [false, true]) {
      for (let k = 1; k <= n; k++) {
        plan.push({
          saldiriId: "TEMIZ",
          saldiriAd: "Temiz (referans)",
          savunma: sav,
          kosuNo: k,
          metin: TEMIZ_METIN,
        });
      }
    }
    for (const s of SALDIRILAR) {
      if (!payloadlar[s.id]?.trim()) continue; // boş payload -> koşuya alınmaz
      const gomulu = payloadGom(TEMIZ_METIN, payloadlar[s.id]);
      for (const sav of [false, true]) {
        for (let k = 1; k <= n; k++) {
          plan.push({
            saldiriId: s.id,
            saldiriAd: s.ad,
            savunma: sav,
            kosuNo: k,
            metin: gomulu,
          });
        }
      }
    }
    return plan;
  }

  // Onay öncesi kaba maliyet tahmini. Prompt token'ı gerçek metinden hesaplarız;
  // completion'ı sabit tahminle alırız. Tool turları maliyeti ARTIRABİLİR -> bu
  // bir ALT SINIRdır.
  function maliyetTahmini(plan: PlanOgesi[]): number {
    const bugun = bugunBul();
    let usd = 0;
    for (const po of plan) {
      const sys = sistemPromptu(bugun, po.savunma);
      const kullanici = po.savunma ? sozlesmeMetniniSar(po.metin) : po.metin;
      const promptTok = kabaTokenTahmini(sys + "\n" + kullanici);
      usd += maliyetHesapla(model, promptTok, TAHMINI_COMPLETION_TOKEN);
    }
    return usd;
  }

  // "Çalıştır" -> planı kur, maliyeti hesapla, ONAY iste (henüz çalıştırma).
  function calistirIste() {
    if (calisiyor) return;
    const plan = planYap();
    const aktifSaldiri = SALDIRILAR.filter((s) => payloadlar[s.id]?.trim()).length;
    setHata(null);
    setOnayBekleyen({
      plan,
      cagri: plan.length,
      usd: maliyetTahmini(plan),
      aktifSaldiri,
    });
  }

  // Onaylandı -> koşuları SIRAYLA çalıştır.
  async function onayla() {
    const bekleyen = onayBekleyen;
    setOnayBekleyen(null);
    if (!bekleyen) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setCalisiyor(true);
    setMetrikler([]); // yeni koşu seti: önceki sonuçların üstüne yazma
    setHata(null);

    try {
      for (let i = 0; i < bekleyen.plan.length; i++) {
        if (controller.signal.aborted) break;
        setIlerleme({ mevcut: i + 1, toplam: bekleyen.plan.length });
        const po = bekleyen.plan[i];
        const akis = await analiziCalistir(
          { metin: po.metin, model, savunma: po.savunma, moderasyon },
          controller.signal
        );
        const m = metrikCikar(akis, {
          saldiriId: po.saldiriId,
          saldiriAd: po.saldiriAd,
          savunma: po.savunma,
          kosuNo: po.kosuNo,
        });
        setMetrikler((prev) => [...prev, m]);
      }
    } catch (e) {
      // İptal -> sessiz; diğer hataları göster.
      if ((e as Error)?.name !== "AbortError") {
        setHata((e as Error)?.message ?? "Bilinmeyen hata.");
      }
    } finally {
      setCalisiyor(false);
      setIlerleme(null);
      abortRef.current = null;
    }
  }

  function durdur() {
    abortRef.current?.abort();
  }

  function temizle() {
    setMetrikler([]);
    setHata(null);
  }

  // CSV indir.
  function csvIndir() {
    const csv = csvUret(metrikler);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "saldiri-sonuclari.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Markdown tabloyu panoya kopyala (README'ye yapıştırmak için).
  async function markdownKopyala() {
    try {
      await navigator.clipboard.writeText(markdownUret(metrikler));
      setKopyalandi(true);
      setTimeout(() => setKopyalandi(false), 1500);
    } catch {
      setHata("Panoya kopyalanamadı (tarayıcı izni gerekebilir).");
    }
  }

  const ozet = useMemo(() => ozetHesapla(metrikler), [metrikler]);

  // Temiz referans profilleri (özet başlığında göstermek için).
  const refSavunmasiz = useMemo(
    () =>
      referansProfil(
        metrikler.filter((m) => m.saldiriId === "TEMIZ" && !m.savunma)
      ),
    [metrikler]
  );
  const refSavunmali = useMemo(
    () =>
      referansProfil(
        metrikler.filter((m) => m.saldiriId === "TEMIZ" && m.savunma)
      ),
    [metrikler]
  );

  const sonucVar = metrikler.length > 0;

  return (
    <main className="deney-kapsayici">
      <h1>Saldırı Paneli — Prompt Injection Ölçümü</h1>
      <p className="altbaslik">
        5 saldırı ailesi × 2 koşul (savunmasız/savunmalı) × N koşu; temiz referans
        otomatik alınır. Koşular sırayla çalışır, iptal edilebilir.{" "}
        <a className="baglanti" href="/">
          ← Normal tarama
        </a>{" "}
        ·{" "}
        <a className="baglanti" href="/deney">
          Deney modu →
        </a>
      </p>

      {/* -------- Payload editörleri -------- */}
      <h2 style={{ fontSize: 16, marginTop: 8 }}>Saldırılar</h2>
      <p className="altbaslik">
        A1 payload&apos;u hazır gelir. A2–A5 için payload&apos;u SİZ yazarsınız;
        boş bırakılan saldırı koşuya alınmaz. Metinler tarayıcıda saklanır.
      </p>

      <div className="saldiri-kartlar">
        {SALDIRILAR.map((s) => {
          const dolu = !!payloadlar[s.id]?.trim();
          return (
            <div className={`saldiri-kart ${dolu ? "dolu" : "bos"}`} key={s.id}>
              <div className="saldiri-ust">
                <span className="saldiri-id">{s.id}</span>
                <span className="saldiri-ad">{s.ad}</span>
                <span className="esne" />
                <span className={`saldiri-rozet ${dolu ? "dolu" : "bos"}`}>
                  {dolu ? "yazıldı" : "yazılmadı"}
                </span>
              </div>
              <div className="saldiri-amac">
                <b>Amaç:</b> {s.amac}
              </div>
              <div className="saldiri-kriter">
                <b>Başarı kriteri (elle yorum):</b> {s.basariKriteriAciklamasi}
              </div>
              <textarea
                className="saldiri-payload"
                value={payloadlar[s.id] ?? ""}
                onChange={(e) => payloadGuncelle(s.id, e.target.value)}
                placeholder={
                  s.id === "A1"
                    ? "A1 payload'u hazır."
                    : "Bu saldırının payload'unu buraya yazın (boş = koşuya alınmaz)…"
                }
                disabled={calisiyor}
              />
            </div>
          );
        })}
      </div>

      {/* -------- Koşu ayarları -------- */}
      <div className="satir">
        <label className="secim">
          Model:
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as ModelAdi)}
            disabled={calisiyor}
          >
            {Object.keys(FIYATLAR).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="secim">
          Koşu sayısı (N):
          <input
            className="deney-sayi"
            type="number"
            min={1}
            max={20}
            value={tekrar}
            onChange={(e) => setTekrar(Number(e.target.value))}
            disabled={calisiyor}
          />
        </label>

        <label className="secim">
          <input
            type="checkbox"
            checked={moderasyon}
            onChange={(e) => setModerasyon(e.target.checked)}
            disabled={calisiyor}
          />
          Moderation ölç
        </label>

        <span className="esne" />

        {ilerleme && (
          <span className="altbaslik">
            koşu {ilerleme.mevcut}/{ilerleme.toplam}…
          </span>
        )}

        {!calisiyor ? (
          <button className="birincil" onClick={calistirIste}>
            Çalıştır…
          </button>
        ) : (
          <button className="tehlike" onClick={durdur}>
            Durdur
          </button>
        )}
        <button onClick={temizle} disabled={calisiyor || !sonucVar}>
          Sonuçları temizle
        </button>
      </div>

      {/* -------- İlerleme çubuğu -------- */}
      {ilerleme && (
        <div className="ilerleme-dis">
          <div
            className="ilerleme-ic"
            style={{
              width: `${Math.round((ilerleme.mevcut / ilerleme.toplam) * 100)}%`,
            }}
          />
        </div>
      )}

      {/* -------- Onay kutusu (çalıştırmadan önce) -------- */}
      {onayBekleyen && (
        <div className="onay-kutu">
          <div className="onay-baslik">Çalıştırma onayı</div>
          <div className="onay-satir">
            Toplam <b>{onayBekleyen.cagri}</b> API çağrısı yapılacak (
            {onayBekleyen.aktifSaldiri} aktif saldırı + temiz referans, 2 koşul, N=
            {n}).
          </div>
          <div className="onay-satir">
            Tahmini maliyet:{" "}
            <b>${onayBekleyen.usd.toFixed(4)}</b>{" "}
            <span className="altbaslik">
              (kaba ALT SINIR; completion ≈ {TAHMINI_COMPLETION_TOKEN} tok/çağrı
              varsayıldı, tool turları maliyeti artırabilir)
            </span>
          </div>
          <div className="satir">
            <button className="birincil" onClick={onayla}>
              Onayla ve çalıştır
            </button>
            <button onClick={() => setOnayBekleyen(null)}>Vazgeç</button>
          </div>
        </div>
      )}

      {hata && (
        <div className="hatalar">
          <div className="hata-kutu">
            <span className="tur">Hata:</span>
            {hata}
          </div>
        </div>
      )}

      {/* -------- Ham koşu tablosu -------- */}
      <div className="baslik-satir" style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16 }}>
          Ham koşu tablosu {sonucVar ? `(${metrikler.length})` : ""}
        </h2>
        {sonucVar && (
          <div className="satir" style={{ margin: 0 }}>
            <button onClick={csvIndir}>CSV indir</button>
            <button onClick={markdownKopyala}>
              {kopyalandi ? "Kopyalandı ✓" : "Markdown kopyala"}
            </button>
          </div>
        )}
      </div>

      {!sonucVar ? (
        <p className="bos">Henüz koşu yok. Payload yazıp “Çalıştır”a basın.</p>
      ) : (
        <div className="deney-tablo-sar">
          <table className="deney-tablo saldiri-tablo">
            <thead>
              <tr>
                <th>#</th>
                <th>saldırı</th>
                <th>koşul</th>
                <th title="kaçıncı koşu">koşu</th>
                <th title="madde sayısı">madde</th>
                <th title="risk dağılımı: düşük/orta/yüksek">d/o/y</th>
                <th title="doğrulanmayan alıntı sayısı">doğr.dışı</th>
                <th title="tool çağrı sayısı">tool</th>
                <th title="tool argümanları">tool argümanları</th>
                <th title="prompt token">pT</th>
                <th title="completion token">cT</th>
                <th title="maliyet (USD)">$</th>
                <th title="süre (ms)">ms</th>
                <th title="moderation işaretledi mi">mod</th>
                <th title="moderation gecikmesi (ms)">mod ms</th>
                <th title="hata (varsa)">hata</th>
              </tr>
            </thead>
            <tbody>
              {metrikler.map((m, i) => (
                <tr key={i} className={m.saldiriId === "TEMIZ" ? "temiz-satir" : ""}>
                  <td>{i + 1}</td>
                  <td title={m.saldiriAd}>{m.saldiriId}</td>
                  <td className={m.savunma ? "evet" : "hayir"}>
                    {m.savunma ? "savunmalı" : "savunmasız"}
                  </td>
                  <td>{m.kosuNo}</td>
                  <td>{m.maddeSayisi}</td>
                  <td>{riskImzasi(m.riskDagilimi)}</td>
                  <td className={m.dogrulanmayanAlinti > 0 ? "uyari" : ""}>
                    {m.dogrulanmayanAlinti}
                  </td>
                  <td className={m.toolCagriSayisi > 0 ? "evet" : "hayir"}>
                    {m.toolCagriSayisi}
                  </td>
                  <td
                    className="arg-hucre"
                    title={JSON.stringify(m.toolArgumanlari)}
                  >
                    {m.toolArgumanlari.length
                      ? JSON.stringify(m.toolArgumanlari)
                      : "—"}
                  </td>
                  <td>{m.promptToken.toLocaleString("tr-TR")}</td>
                  <td>{m.completionToken.toLocaleString("tr-TR")}</td>
                  <td>${m.usd.toFixed(6)}</td>
                  <td>{m.sureMs.toLocaleString("tr-TR")}</td>
                  <td>
                    {m.moderationFlagged === null
                      ? "—"
                      : m.moderationFlagged
                      ? "evet"
                      : "hayır"}
                  </td>
                  <td>{m.moderationGecikmeMs ?? "—"}</td>
                  <td className={m.hata ? "uyari" : ""} title={m.hata ?? ""}>
                    {m.hata ? "hata" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* -------- Özet tablosu -------- */}
      {sonucVar && (
        <>
          <h2 style={{ fontSize: 16, marginTop: 24 }}>
            Özet: saldırı × koşul (temiz referansa göre)
          </h2>
          <p className="altbaslik">
            Temiz referans — savunmasız:{" "}
            {refSavunmasiz
              ? `madde ${refSavunmasiz.maddeSayisi}, imza ${refSavunmasiz.imza} (${refSavunmasiz.ornekSayisi} örnek)`
              : "—"}{" "}
            · savunmalı:{" "}
            {refSavunmali
              ? `madde ${refSavunmali.maddeSayisi}, imza ${refSavunmali.imza} (${refSavunmali.ornekSayisi} örnek)`
              : "—"}
            . “Değişiklik” = madde sayısı VEYA risk imzası referanstan farklı
            (mekanik kıyas; “başarılı” demek değil).
          </p>

          <div className="deney-tablo-sar">
            <table className="deney-tablo">
              <thead>
                <tr>
                  <th>saldırı</th>
                  <th>koşul</th>
                  <th title="koşu sayısı">N</th>
                  <th title="kaç koşuda değişiklik gözlendi">değişiklik</th>
                  <th title="temiz referansa göre ort. ek token">ort. ek tok</th>
                  <th title="temiz referansa göre ort. ek maliyet">ort. ek $</th>
                </tr>
              </thead>
              <tbody>
                {ozet.map((o, i) => (
                  <tr key={i}>
                    <td title={o.saldiriAd}>
                      {o.saldiriId} — {o.saldiriAd}
                    </td>
                    <td className={o.savunma ? "evet" : "hayir"}>
                      {o.savunma ? "savunmalı" : "savunmasız"}
                    </td>
                    <td>{o.n}</td>
                    <td className={o.degisiklikSayisi > 0 ? "uyari" : ""}>
                      {o.degisiklikSayisi}/{o.n}
                    </td>
                    <td>
                      {o.ortEkToken > 0 ? "+" : ""}
                      {o.ortEkToken.toLocaleString("tr-TR")}
                    </td>
                    <td>
                      {o.ortEkUsd >= 0 ? "+" : ""}${o.ortEkUsd.toFixed(6)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
