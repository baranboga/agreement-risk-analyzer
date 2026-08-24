"use client";

// app/page.tsx
// -----------------------------------------------------------------------------
// Tek sayfalık arayüz:
//   - Metin yapıştırma alanı
//   - Model + mod (A/B) seçimi
//   - "Tarama" ve "Durdur" (AbortController) butonları
//   - Üstte CANLI token & maliyet göstergesi
//   - Akan sonuç kartları + tool günlüğü + hata kutuları
//
// İki mod:
//   MOD A: tüm içerik birikir, akış BİTİNCE tek seferde parse edilir (+zod).
//   MOD B: her delta'da yarım JSON'dan TAMAMLANAN kartlar ayıklanıp gösterilir
//          (bkz. lib/partial.ts).
// -----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { AnalizSchema, type Madde } from "@/lib/schema";
import { tamamlananMaddeler } from "@/lib/partial";
import { ORNEKLER } from "@/lib/ornekler";
import {
  FIYATLAR,
  maliyetHesapla,
  kabaTokenTahmini,
  type ModelAdi,
} from "@/lib/cost";
import type { SunucuOlayi } from "@/lib/protocol";

// UI tarafı yardımcı tipler
type HataOgesi = { kind: string; mesaj: string };
type ToolOgesi = { isim: string; args: unknown; sonuc: string; tur: number };
type Kullanim = {
  promptToken: number;
  completionToken: number;
  toolTuru: number;
  usd: number;
};

// Kartlar hem mod A (tam Madde) hem mod B (tamamlanmış nesne) verisini gösterir.
type MaddeGorunum = Partial<Madde> & Record<string, unknown>;

// Süre ölçümleri (milisaniye cinsinden, hepsi client tarafında).
//   ttft    -> istek gönderiminden stream'in İLK chunk'ına kadar
//   ilkKart -> istek gönderiminden ilk kartın DOM'a BOYANDIĞI ana kadar
//   toplam  -> istek gönderiminden stream kapandığı ana kadar
type Sureler = { ttft: number | null; ilkKart: number | null; toplam: number | null };

// ms -> "9.2s" (saniye, tek ondalık). Değer yoksa "—".
function saniye(ms: number | null): string {
  if (ms == null) return "—";
  return (ms / 1000).toFixed(1) + "s";
}

const RISK_ETIKET: Record<string, string> = {
  dusuk: "Düşük",
  orta: "Orta",
  yuksek: "Yüksek",
};

const HATA_BASLIK: Record<string, string> = {
  rate_limit: "Hız Sınırı",
  gecersiz_json: "Geçersiz JSON",
  tool_hatasi: "Tool Hatası",
  bilinmeyen: "Hata",
};

export default function Sayfa() {
  const [ornekId, setOrnekId] = useState(ORNEKLER[0].id);
  const [metin, setMetin] = useState(ORNEKLER[0].metin);
  const [model, setModel] = useState<ModelAdi>("gpt-4.1");
  const [mod, setMod] = useState<"A" | "B">("B");

  const [calisiyor, setCalisiyor] = useState(false);
  const [maddeler, setMaddeler] = useState<MaddeGorunum[]>([]);
  const [toollar, setToollar] = useState<ToolOgesi[]>([]);
  const [hatalar, setHatalar] = useState<HataOgesi[]>([]);
  const [kullanim, setKullanim] = useState<Kullanim | null>(null);

  // Canlı (tahmini) sayaçlar — kesin usage gelene kadar gösterilir.
  const [canliPrompt, setCanliPrompt] = useState(0);
  const [canliCompletion, setCanliCompletion] = useState(0);

  // Süre ölçümleri.
  const [sureler, setSureler] = useState<Sureler>({
    ttft: null,
    ilkKart: null,
    toplam: null,
  });

  // Durdur butonu bu controller'ı iptal eder.
  const abortRef = useRef<AbortController | null>(null);

  // Ölçüm referansları. performance.now() KULLANIYORUZ (Date.now() değil):
  // performance.now() monotonik saattir, sistem saati değişse bile geriye
  // gitmez; süre farkı ölçümü için doğru araç.
  const baslangicRef = useRef<number>(0); // istek gönderim anı
  const ttftAlindiRef = useRef(false); // TTFT bir kez ölçülsün
  const ilkKartAlindiRef = useRef(false); // ilk kart bir kez ölçülsün

  // İLK KART ölçümü — neden burada, tara() içinde değil:
  // "İlk kart" süresini setMaddeler çağrıldığı an (veri parse edildiği an)
  // DEĞİL, kartın gerçekten EKRANA BOYANDIĞI an almalıyız. Bu effect, React
  // maddeler'i DOM'a commit ettikten SONRA çalışır; requestAnimationFrame ise
  // ölçümü tarayıcının bir sonraki boyamasına kilitler. Böylece damga, kartın
  // fiilen görünür olduğu ana denk gelir.
  useEffect(() => {
    if (maddeler.length > 0 && !ilkKartAlindiRef.current) {
      ilkKartAlindiRef.current = true; // tekrar planlamayı engelle
      // NOT: rAF'i bilerek İPTAL ETMİYORUZ. Mod B'de maddeler hızla değişir;
      // bir cleanup ile iptal etsek, bekleyen ölçüm çağrısı boyamadan önce
      // düşerdi. Guard sayesinde tarama başına yalnızca bir rAF planlanır.
      requestAnimationFrame(() => {
        const t = performance.now() - baslangicRef.current;
        setSureler((s) => ({ ...s, ilkKart: t }));
      });
    }
  }, [maddeler]);

  // Gösterilecek değerler: kesin usage varsa onu, yoksa canlı tahmini kullan.
  const gosterim = useMemo(() => {
    if (kullanim) {
      return {
        prompt: kullanim.promptToken,
        completion: kullanim.completionToken,
        usd: kullanim.usd,
        kesin: true,
      };
    }
    return {
      prompt: canliPrompt,
      completion: canliCompletion,
      usd: maliyetHesapla(model, canliPrompt, canliCompletion),
      kesin: false,
    };
  }, [kullanim, canliPrompt, canliCompletion, model]);

  async function tara() {
    // Durumu sıfırla.
    setMaddeler([]);
    setToollar([]);
    setHatalar([]);
    setKullanim(null);
    setCanliPrompt(kabaTokenTahmini(metin)); // prompt için kaba başlangıç tahmini
    setCanliCompletion(0);
    setCalisiyor(true);

    // Ölçümleri sıfırla ve guard'ları serbest bırak.
    setSureler({ ttft: null, ilkKart: null, toplam: null });
    ttftAlindiRef.current = false;
    ilkKartAlindiRef.current = false;

    const controller = new AbortController();
    abortRef.current = controller;

    // State asenkron güncellendiği için akış boyunca LOKAL bir birikimci tutuyoruz.
    let ham = "";

    // ÖLÇÜM BAŞLANGICI: "istek gönderildiği an". fetch'ten hemen önce damgala.
    baslangicRef.current = performance.now();

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metin, model }),
        signal: controller.signal,
      });

      if (!res.body) throw new Error("Sunucudan akış (stream) gelmedi.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let tampon = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // TTFT: stream'den GERÇEK ilk chunk geldiği an (sunucu içi süre değil,
        // kullanıcının beklediği ağ + üretim süresi). Yalnızca bir kez ölç.
        if (!ttftAlindiRef.current) {
          ttftAlindiRef.current = true;
          const t = performance.now() - baslangicRef.current;
          setSureler((s) => ({ ...s, ttft: t }));
        }

        tampon += decoder.decode(value, { stream: true });

        // SSE olayları \n\n ile ayrılır.
        let sinir: number;
        while ((sinir = tampon.indexOf("\n\n")) !== -1) {
          const blok = tampon.slice(0, sinir);
          tampon = tampon.slice(sinir + 2);

          const satir = blok.split("\n").find((s) => s.startsWith("data:"));
          if (!satir) continue;

          const olay = JSON.parse(satir.slice(5).trim()) as SunucuOlayi;

          if (olay.tip === "delta") {
            ham += olay.metin;
            // Canlı completion token tahminini güncelle.
            setCanliCompletion(kabaTokenTahmini(ham));
            // MOD B: her delta'da tamamlanan kartları göster.
            if (mod === "B") {
              setMaddeler(tamamlananMaddeler(ham) as MaddeGorunum[]);
            }
          } else if (olay.tip === "tool") {
            setToollar((t) => [
              ...t,
              { isim: olay.isim, args: olay.args, sonuc: olay.sonuc, tur: olay.tur },
            ]);
          } else if (olay.tip === "kullanim") {
            // Kesin token/maliyet geldi.
            setKullanim({
              promptToken: olay.promptToken,
              completionToken: olay.completionToken,
              toolTuru: olay.toolTuru,
              usd: olay.usd,
            });
          } else if (olay.tip === "hata") {
            setHatalar((h) => [...h, { kind: olay.kind, mesaj: olay.mesaj }]);
          } else if (olay.tip === "bitti") {
            // MOD A: akış bitince tamamını tek seferde parse + zod doğrula.
            if (mod === "A") {
              modAParse(ham);
            }
          }
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        // Kullanıcı "Durdur"a bastı: mevcut kartları ve (tahmini) maliyeti KORU.
        // Bilerek hiçbir şeyi sıfırlamıyoruz.
      } else {
        setHatalar((h) => [...h, { kind: "bilinmeyen", mesaj: err.message }]);
      }
    } finally {
      // TOPLAM: stream kapandığı an (normal bitiş, hata veya iptal — üçü de
      // buraya düşer, yani iptalde "o ana kadarki toplam" da ekranda kalır).
      // Fonksiyonel güncelleme ile daha önce ölçülen ttft/ilkKart korunur.
      const t = performance.now() - baslangicRef.current;
      setSureler((s) => ({ ...s, toplam: t }));

      setCalisiyor(false);
      abortRef.current = null;
    }
  }

  // MOD A: tam metni parse et; JSON geçersizse veya şemaya uymuyorsa ayrı ayrı
  // hata göster.
  function modAParse(ham: string) {
    let obj: unknown;
    try {
      obj = JSON.parse(ham);
    } catch {
      setHatalar((h) => [
        ...h,
        { kind: "gecersiz_json", mesaj: "Model geçerli JSON üretemedi (mod A)." },
      ]);
      return;
    }
    // zod ile şema doğrulaması (çalışma zamanı güvencesi).
    const sonuc = AnalizSchema.safeParse(obj);
    if (sonuc.success) {
      setMaddeler(sonuc.data.maddeler);
    } else {
      const alanlar = sonuc.error.issues
        .map((i) => i.path.join(".") || "(kök)")
        .join(", ");
      setHatalar((h) => [
        ...h,
        {
          kind: "gecersiz_json",
          mesaj: `Çıktı şemaya uymuyor. Sorunlu alan(lar): ${alanlar}`,
        },
      ]);
    }
  }

  function durdur() {
    // İsteği gerçekten iptal et. Bu, client fetch'i ve zincirleme olarak
    // sunucudaki upstream OpenAI fetch'ini de abort eder.
    abortRef.current?.abort();
  }

  // Örnek seçildiğinde metni textarea'ya yükle. Kullanıcı sonra serbestçe
  // düzenleyebilir; seçim yalnızca başlangıç metnini belirler.
  function ornekSec(id: string) {
    const o = ORNEKLER.find((x) => x.id === id);
    if (!o) return;
    setOrnekId(id);
    setMetin(o.metin);
  }

  const bosMu = !metin.trim();

  return (
    <main className="kapsayici">
      <h1>Sözleşme Risk Tarayıcısı</h1>
      <p className="altbaslik">
        Metni yapıştır, tara; riskli maddeler risk seviyesine göre akar. (OpenAI,
        ham fetch + SSE — öğrenme amaçlı.)
      </p>

      {/* Canlı token & maliyet göstergesi */}
      <div className="gosterge">
        <div className="kutu">
          <span className="etiket">Prompt Token</span>
          <span className="deger">
            {gosterim.prompt.toLocaleString("tr-TR")}
            <span className={`rozet ${gosterim.kesin ? "kesin" : ""}`}>
              {gosterim.kesin ? "kesin" : "tahmini"}
            </span>
          </span>
        </div>
        <div className="kutu">
          <span className="etiket">Completion Token</span>
          <span className="deger">
            {gosterim.completion.toLocaleString("tr-TR")}
            <span className={`rozet ${gosterim.kesin ? "kesin" : ""}`}>
              {gosterim.kesin ? "kesin" : "tahmini"}
            </span>
          </span>
        </div>
        <div className="kutu">
          <span className="etiket">Tool Turu</span>
          <span className="deger">{kullanim ? kullanim.toolTuru : toollar.length}</span>
        </div>
        <div className="kutu">
          <span className="etiket">Toplam Maliyet</span>
          <span className="deger">
            ${gosterim.usd.toFixed(6)}
            <span className={`rozet ${gosterim.kesin ? "kesin" : ""}`}>
              {gosterim.kesin ? "kesin" : "tahmini"}
            </span>
          </span>
        </div>
        <div className="kutu">
          <span className="etiket">TTFT</span>
          <span className="deger">{saniye(sureler.ttft)}</span>
        </div>
        <div className="kutu">
          <span className="etiket">İlk Kart</span>
          <span className="deger">{saniye(sureler.ilkKart)}</span>
        </div>
        <div className="kutu">
          <span className="etiket">Toplam</span>
          <span className="deger">{saniye(sureler.toplam)}</span>
        </div>
      </div>

      {/* Giriş */}
      <textarea
        value={metin}
        onChange={(e) => setMetin(e.target.value)}
        placeholder="Sözleşme metnini buraya yapıştırın..."
        disabled={calisiyor}
      />

      <div className="satir">
        <label className="secim">
          Örnek:
          <select
            value={ornekId}
            onChange={(e) => ornekSec(e.target.value)}
            disabled={calisiyor}
          >
            {ORNEKLER.map((o) => (
              <option key={o.id} value={o.id}>
                {o.ad}
              </option>
            ))}
          </select>
        </label>

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
          Mod:
          <select
            value={mod}
            onChange={(e) => setMod(e.target.value as "A" | "B")}
            disabled={calisiyor}
          >
            <option value="A">A — tam cevabı bekle, sonra parse et</option>
            <option value="B">B — kısmi JSON'u tolere et, kartları akıt</option>
          </select>
        </label>

        <span className="esne" />

        {!calisiyor ? (
          <button className="birincil" onClick={tara} disabled={bosMu}>
            Tarama
          </button>
        ) : (
          <button className="tehlike" onClick={durdur}>
            Durdur
          </button>
        )}
      </div>

      {/* Hatalar (üç kategori ayrı ayrı, renkli) */}
      {hatalar.length > 0 && (
        <div className="hatalar">
          {hatalar.map((h, i) => (
            <div className="hata-kutu" key={i}>
              <span className="tur">{HATA_BASLIK[h.kind] ?? "Hata"}:</span>
              {h.mesaj}
            </div>
          ))}
        </div>
      )}

      {/* Sonuç kartları */}
      <div className="baslik-satir">
        <h2 style={{ fontSize: 16 }}>
          Bulgular {maddeler.length > 0 ? `(${maddeler.length})` : ""}
        </h2>
        {calisiyor && <span className="altbaslik">taranıyor…</span>}
      </div>

      {maddeler.length === 0 && !calisiyor ? (
        <p className="bos">Henüz bulgu yok. Bir metin tarayın.</p>
      ) : (
        <div className="kartlar">
          {maddeler.map((m, i) => (
            <MaddeKarti key={i} m={m} />
          ))}
        </div>
      )}

      {/* Tool günlüğü */}
      {toollar.length > 0 && (
        <div className="tool-gunlugu">
          <h2 style={{ fontSize: 14, color: "var(--muted)" }}>Tool Günlüğü</h2>
          {toollar.map((t, i) => (
            <div className="tool-satir" key={i}>
              [tur {t.tur}] <b>{t.isim}</b>(
              {JSON.stringify(t.args)}) → {t.sonuc}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

// Tek bir madde kartı. Mod B'de alanlar eksik olabileceğinden hepsi opsiyonel
// gibi ele alınır.
function MaddeKarti({ m }: { m: MaddeGorunum }) {
  const seviye = (m.riskSeviyesi as string) ?? "orta";
  return (
    <div className={`kart ${seviye}`}>
      <div className="ust">
        <span className={`risk-etiket ${seviye}`}>
          {RISK_ETIKET[seviye] ?? seviye}
        </span>
      </div>

      {m.alinti && <blockquote>“{String(m.alinti)}”</blockquote>}

      {m.gerekce && (
        <>
          <div className="satir-etiket">Gerekçe</div>
          <div>{String(m.gerekce)}</div>
        </>
      )}

      {m.oneri && (
        <>
          <div className="satir-etiket">Öneri</div>
          <div>{String(m.oneri)}</div>
        </>
      )}

      {m.sureIfadesi ? <div className="sure">⏱ {String(m.sureIfadesi)}</div> : null}
    </div>
  );
}
