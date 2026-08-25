// lib/olcum.ts
// -----------------------------------------------------------------------------
// ÖLÇÜM — saldırı panelinin metrik tipleri, karşılaştırma ve dışa aktarma.
//
// Bir "koşu" = bir metnin (temiz ya da payload gömülü) tek bir koşulda (savunmalı/
// savunmasız) tek kez analiz edilmesi. Her koşudan KosuMetrik çıkarırız.
//
// ÖNEMLİ İLKE: Bu dosya "saldırı başarılı" DİYE YORUM YAPMAZ. Yalnızca ham metrik
// üretir ve "temiz referanstan MEKANİK OLARAK farklı mı" (değişiklik gözlendi)
// bilgisini verir. Nihai "başarılı/başarısız" etiketini kullanıcı ELLE koyar.
// -----------------------------------------------------------------------------

import type { AkisSonucu } from "./istemciAkis";
import { AnalizSchema } from "./schema";

export type RiskDagilimi = { dusuk: number; orta: number; yuksek: number };

export type KosuMetrik = {
  saldiriId: string; // "A1".."A5" veya "TEMIZ"
  saldiriAd: string;
  savunma: boolean; // true -> savunmalı, false -> savunmasız
  kosuNo: number; // 1..N
  maddeSayisi: number;
  riskDagilimi: RiskDagilimi;
  dogrulanmayanAlinti: number; // çıkış doğrulamasından geçemeyen madde sayısı
  toolCagriSayisi: number;
  toolArgumanlari: unknown[]; // her tool çağrısının argümanları (ham tabloda gösterilir)
  promptToken: number;
  completionToken: number;
  usd: number;
  sureMs: number;
  moderationFlagged: boolean | null; // moderation kapalıysa null
  moderationGecikmeMs: number | null; // moderation kapalıysa null
  hata: string | null;
};

// -----------------------------------------------------------------------------
// AkisSonucu -> KosuMetrik
// -----------------------------------------------------------------------------

/** Bir maddenin risk seviyelerini sayar. */
export function riskDagilimiHesapla(
  maddeler: { riskSeviyesi?: unknown }[]
): RiskDagilimi {
  const d: RiskDagilimi = { dusuk: 0, orta: 0, yuksek: 0 };
  for (const m of maddeler) {
    const s = m?.riskSeviyesi;
    if (s === "dusuk" || s === "orta" || s === "yuksek") d[s]++;
  }
  return d;
}

/**
 * Akış sonucundan (bir koşu) ölçülebilir metrikleri çıkarır.
 * Nihai JSON'u parse eder; şemaya tam uymasa bile maddeler dizisini saymaya çalışır.
 */
export function metrikCikar(
  s: AkisSonucu,
  bilgi: {
    saldiriId: string;
    saldiriAd: string;
    savunma: boolean;
    kosuNo: number;
  }
): KosuMetrik {
  let maddeler: { riskSeviyesi?: unknown; alinti?: unknown }[] = [];
  try {
    const obj = JSON.parse(s.ham);
    const r = AnalizSchema.safeParse(obj);
    if (r.success) {
      maddeler = r.data.maddeler;
    } else if (Array.isArray(obj?.maddeler)) {
      // Şemaya tam uymasa da (ör. saldırı bozduysa) sayabildiğimizi sayalım.
      maddeler = obj.maddeler;
    }
  } catch {
    // Geçersiz JSON -> boş; hata alanı zaten s.hatalar'da yakalanmış olur.
  }

  return {
    ...bilgi,
    maddeSayisi: maddeler.length,
    riskDagilimi: riskDagilimiHesapla(maddeler),
    // dogrulama dizisi varsa false'ları say; yoksa 0.
    dogrulanmayanAlinti: s.dogrulama
      ? s.dogrulama.filter((x) => !x).length
      : 0,
    toolCagriSayisi: s.toollar.length,
    toolArgumanlari: s.toollar.map((t) => t.args),
    promptToken: s.kullanim?.promptToken ?? 0,
    completionToken: s.kullanim?.completionToken ?? 0,
    usd: s.kullanim?.usd ?? 0,
    sureMs: Math.round(s.sureMs),
    moderationFlagged: s.moderation ? s.moderation.flagged : null,
    moderationGecikmeMs: s.moderation ? s.moderation.gecikmeMs : null,
    hata: s.hatalar.length ? s.hatalar.map((h) => h.mesaj).join(" | ") : null,
  };
}

// -----------------------------------------------------------------------------
// TEMİZ REFERANSA GÖRE KARŞILAŞTIRMA
//
// "değişiklik gözlendi" = bir saldırı koşusunun madde sayısı VEYA risk imzası,
// AYNI KOŞULDAKİ temiz referanstan farklı. Referansı "en sık" (mod) değerle
// tanımlarız: LLM çıktısı doğal olarak biraz oynar; mod, en temsili tek değerdir.
//
// UYARI: Bu MEKANİK bir farktır, "saldırı başarılı" demek DEĞİLDİR — doğal
// değişkenlik de tetikleyebilir. Yorum kullanıcıya aittir.
// -----------------------------------------------------------------------------

export function riskImzasi(d: RiskDagilimi): string {
  return `${d.dusuk}/${d.orta}/${d.yuksek}`;
}

export type ReferansProfil = {
  maddeSayisi: number;
  imza: string;
  ornekSayisi: number;
};

/** Bir dizideki en sık (mod) elemanı döndürür. */
function enSik<T>(dizi: T[]): T {
  const sayac = new Map<T, number>();
  for (const x of dizi) sayac.set(x, (sayac.get(x) ?? 0) + 1);
  let enIyi = dizi[0];
  let enCok = -1;
  for (const [k, v] of sayac) {
    if (v > enCok) {
      enCok = v;
      enIyi = k;
    }
  }
  return enIyi;
}

/** Temiz koşulardan referans profili (en sık madde sayısı + en sık risk imzası). */
export function referansProfil(temizKosular: KosuMetrik[]): ReferansProfil | null {
  if (temizKosular.length === 0) return null;
  return {
    maddeSayisi: enSik(temizKosular.map((k) => k.maddeSayisi)),
    imza: enSik(temizKosular.map((k) => riskImzasi(k.riskDagilimi))),
    ornekSayisi: temizKosular.length,
  };
}

/** Bir koşu, referanstan (madde sayısı veya risk imzası) farklı mı? */
export function degisiklikVarMi(
  kosu: KosuMetrik,
  ref: ReferansProfil | null
): boolean {
  if (!ref) return false;
  return (
    kosu.maddeSayisi !== ref.maddeSayisi ||
    riskImzasi(kosu.riskDagilimi) !== ref.imza
  );
}

// -----------------------------------------------------------------------------
// ÖZET TABLOSU: saldırı ailesi × savunmasız/savunmalı
// -----------------------------------------------------------------------------

export type OzetSatir = {
  saldiriId: string;
  saldiriAd: string;
  savunma: boolean;
  n: number; // bu hücredeki koşu sayısı
  degisiklikSayisi: number; // kaç koşuda temiz referanstan sapıldı
  ortEkToken: number; // temiz referansa göre ort. ek (prompt+completion) token
  ortEkUsd: number; // temiz referansa göre ort. ek maliyet
};

function ortToplamToken(ms: KosuMetrik[]): number {
  if (ms.length === 0) return 0;
  return ms.reduce((a, m) => a + m.promptToken + m.completionToken, 0) / ms.length;
}
function ortUsd(ms: KosuMetrik[]): number {
  if (ms.length === 0) return 0;
  return ms.reduce((a, m) => a + m.usd, 0) / ms.length;
}

/** Tüm metriklerden özet satırlarını üretir (temiz referans satırları hariç). */
export function ozetHesapla(metrikler: KosuMetrik[]): OzetSatir[] {
  const temiz = (sav: boolean) =>
    metrikler.filter((m) => m.saldiriId === "TEMIZ" && m.savunma === sav);

  const ref = {
    savunmasiz: referansProfil(temiz(false)),
    savunmali: referansProfil(temiz(true)),
  };
  const temizToken = {
    savunmasiz: ortToplamToken(temiz(false)),
    savunmali: ortToplamToken(temiz(true)),
  };
  const temizUsd = {
    savunmasiz: ortUsd(temiz(false)),
    savunmali: ortUsd(temiz(true)),
  };

  // Saldırı id'lerini görülme sırasına göre (TEMIZ hariç) topla.
  const idler: string[] = [];
  for (const m of metrikler) {
    if (m.saldiriId !== "TEMIZ" && !idler.includes(m.saldiriId)) {
      idler.push(m.saldiriId);
    }
  }

  const satirlar: OzetSatir[] = [];
  for (const id of idler) {
    for (const sav of [false, true]) {
      const hucre = metrikler.filter(
        (m) => m.saldiriId === id && m.savunma === sav
      );
      if (hucre.length === 0) continue;
      const refProfil = sav ? ref.savunmali : ref.savunmasiz;
      const refToken = sav ? temizToken.savunmali : temizToken.savunmasiz;
      const refUsd = sav ? temizUsd.savunmali : temizUsd.savunmasiz;
      satirlar.push({
        saldiriId: id,
        saldiriAd: hucre[0].saldiriAd,
        savunma: sav,
        n: hucre.length,
        degisiklikSayisi: hucre.filter((m) => degisiklikVarMi(m, refProfil))
          .length,
        ortEkToken: Math.round(ortToplamToken(hucre) - refToken),
        ortEkUsd: ortUsd(hucre) - refUsd,
      });
    }
  }
  return satirlar;
}

// -----------------------------------------------------------------------------
// DIŞA AKTARMA (CSV + Markdown) — ham koşu tablosu
// -----------------------------------------------------------------------------

const BASLIKLAR = [
  "saldiri",
  "saldiriAd",
  "savunma",
  "kosuNo",
  "maddeSayisi",
  "dusuk",
  "orta",
  "yuksek",
  "dogrulanmayanAlinti",
  "toolCagri",
  "toolArgumanlari",
  "promptToken",
  "completionToken",
  "usd",
  "sureMs",
  "moderationFlagged",
  "moderationGecikmeMs",
  "hata",
] as const;

function satirDegerleri(m: KosuMetrik): (string | number)[] {
  return [
    m.saldiriId,
    m.saldiriAd,
    m.savunma ? "savunmali" : "savunmasiz",
    m.kosuNo,
    m.maddeSayisi,
    m.riskDagilimi.dusuk,
    m.riskDagilimi.orta,
    m.riskDagilimi.yuksek,
    m.dogrulanmayanAlinti,
    m.toolCagriSayisi,
    JSON.stringify(m.toolArgumanlari),
    m.promptToken,
    m.completionToken,
    m.usd.toFixed(6),
    m.sureMs,
    m.moderationFlagged === null ? "" : m.moderationFlagged ? "evet" : "hayir",
    m.moderationGecikmeMs ?? "",
    m.hata ?? "",
  ];
}

/** Ham koşu tablosunu CSV metnine çevirir (tırnak kaçışlı). */
export function csvUret(metrikler: KosuMetrik[]): string {
  const kacir = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const satirlar = [BASLIKLAR.join(",")];
  for (const m of metrikler) {
    satirlar.push(satirDegerleri(m).map(kacir).join(","));
  }
  return satirlar.join("\n");
}

/** Ham koşu tablosunu Markdown tablosuna çevirir (README'ye yapıştırmak için). */
export function markdownUret(metrikler: KosuMetrik[]): string {
  const kacir = (v: string | number) =>
    String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const satirlar = [
    `| ${BASLIKLAR.join(" | ")} |`,
    `| ${BASLIKLAR.map(() => "---").join(" | ")} |`,
  ];
  for (const m of metrikler) {
    satirlar.push(`| ${satirDegerleri(m).map(kacir).join(" | ")} |`);
  }
  return satirlar.join("\n");
}
