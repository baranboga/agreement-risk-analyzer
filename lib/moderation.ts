// lib/moderation.ts
// -----------------------------------------------------------------------------
// OpenAI Moderation API'ye TEK çağrı. Girdiyi ENGELLEMEYİZ — sadece işaretleriz.
//
// ===== SAVUNMA KATMANI 6 — MODERATION (opsiyonel ön-filtre) =================
// Bu katman HANGİ saldırıyı durdurur: Açıkça POLİTİKA-İHLALİ içerik (nefret,
//   şiddet, taciz, yasa dışı içerik vb.) taşıyan girdileri işaretler. Sözleşme
//   metnine gizlenmiş böyle bir içerik varsa görünür kılar.
// Bu katman HANGİsini DURDURMAZ: A1–A5'in HİÇBİRİNİ doğrudan. Prompt injection
//   "zararlı içerik" değil, "talimat gaspı"dır; moderation modeli bunu yakalamak
//   için EĞİTİLMEDİ — "önceki talimatları yok say" cümlesi politika ihlali
//   sayılmaz. Bu yüzden burada girdiyi engellemiyor, yalnızca ÖLÇÜM/görünürlük
//   amaçlı ek bir sinyal olarak topluyoruz. (Eklediği latency ayrı ölçülür.)
// -----------------------------------------------------------------------------
//
// GÜVENLİK: OPENAI_API_KEY yalnızca sunucuda (burada) okunur.
// NOT: Bu çağrı HİÇBİR koşulda ana analizi patlatmamalı. Hata olursa flagged=null
//      döner (=işaretleyemedik) ve akış devam eder; iptal (AbortError) ise dışarı
//      fırlatılır ki üst katman isteği düzgün iptal edebilsin.
// -----------------------------------------------------------------------------

const MODERATION_URL = "https://api.openai.com/v1/moderations";
// Güncel çok-kipli moderation modeli. Erişilemezse aşağıda düzgün hata dönüyoruz.
const MODERATION_MODEL = "omni-moderation-latest";

export type ModerasyonSonucu = {
  // true/false -> API cevap verdi; null -> çağrı yapılamadı/başarısız (engellemedik).
  flagged: boolean | null;
  kategoriler: string[]; // işaretlenen (true) kategori adları
  gecikmeMs: number; // bu çağrının EKLEDİĞİ gecikme (ölçüm için)
  hata?: string; // varsa hata açıklaması
};

/**
 * Metni moderation API'ye gönderir, işaretli olup olmadığını ve eklediği gecikmeyi
 * döndürür. Metni ENGELLEMEZ.
 */
export async function moderasyonKontrol(
  metin: string,
  signal?: AbortSignal
): Promise<ModerasyonSonucu> {
  const t0 = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      flagged: null,
      kategoriler: [],
      gecikmeMs: 0,
      hata: "OPENAI_API_KEY tanımlı değil; moderation atlandı.",
    };
  }

  try {
    const res = await fetch(MODERATION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODERATION_MODEL, input: metin }),
      signal,
    });
    const gecikmeMs = Date.now() - t0;

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return {
        flagged: null,
        kategoriler: [],
        gecikmeMs,
        hata: `Moderation ${res.status}: ${t.slice(0, 200)}`,
      };
    }

    const j = await res.json();
    const r = j?.results?.[0];
    const flagged = typeof r?.flagged === "boolean" ? r.flagged : null;
    // categories: { "hate": false, "violence": true, ... } -> true olanların adı.
    const kategoriler =
      r?.categories && typeof r.categories === "object"
        ? Object.entries(r.categories)
            .filter(([, v]) => v === true)
            .map(([k]) => k)
        : [];

    return { flagged, kategoriler, gecikmeMs };
  } catch (e) {
    // İptal isteğini üst katmana bırak (analizle birlikte düzgün iptal olsun).
    if ((e as Error)?.name === "AbortError") throw e;
    return {
      flagged: null,
      kategoriler: [],
      gecikmeMs: Date.now() - t0,
      hata: (e as Error)?.message ?? "Moderation çağrısı başarısız.",
    };
  }
}
