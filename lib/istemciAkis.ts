// lib/istemciAkis.ts
// -----------------------------------------------------------------------------
// İstemci tarafı yardımcı: /api/analyze SSE akışını SONUNA KADAR tüketir ve TEK
// bir toplu sonuç döndürür.
//
// Kimin için: SALDIRI PANELİ (app/saldiri). Panel akışı canlı göstermez; yalnızca
// bir koşunun NİHAİ metriklerini toplamak ister. Ana sayfa (app/page.tsx) kendi
// canlı akış döngüsünü ayrı yürütür; BU YARDIMCI ONU ETKİLEMEZ (mimari korunur).
//
// Not: SSE ayrıştırma mantığı ana sayfadakiyle aynı biçimdedir ama burada canlı
// delta göstermeye gerek yok; sadece toplayıp döndürüyoruz.
// -----------------------------------------------------------------------------

import type { SunucuOlayi } from "./protocol";

export type AnalizParametreleri = {
  metin: string;
  model: string;
  savunma: boolean;
  moderasyon: boolean;
};

export type ToplananTool = {
  isim: string;
  args: unknown;
  sonuc: string;
  tur: number;
};

export type AkisSonucu = {
  ham: string; // biriken ham içerik (nihai JSON metni)
  toollar: ToplananTool[];
  kullanim: {
    promptToken: number;
    completionToken: number;
    toolTuru: number;
    usd: number;
  } | null;
  dogrulama: boolean[] | null; // her madde için alıntı doğrulandı mı
  moderation: {
    flagged: boolean | null;
    kategoriler: string[];
    gecikmeMs: number;
  } | null;
  hatalar: { kind: string; mesaj: string }[];
  sureMs: number; // istekten akış kapanışına kadar (client ölçümü)
};

/**
 * Tek bir analiz koşusunu çalıştırır ve toplu sonucu döndürür.
 * @param p      istek parametreleri (metin/model/savunma/moderasyon)
 * @param signal iptal için AbortSignal (panelin Durdur'u)
 */
export async function analiziCalistir(
  p: AnalizParametreleri,
  signal: AbortSignal
): Promise<AkisSonucu> {
  const sonuc: AkisSonucu = {
    ham: "",
    toollar: [],
    kullanim: null,
    dogrulama: null,
    moderation: null,
    hatalar: [],
    sureMs: 0,
  };

  // performance.now() -> monotonik; süre ölçümü için doğru araç.
  const t0 = performance.now();

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
    signal,
  });

  // Giriş doğrulaması (400) veya başka HTTP hatası: gövde JSON bir hata olayıdır.
  if (!res.ok) {
    const olay = await res.json().catch(() => null);
    sonuc.hatalar.push({
      kind: (olay?.kind as string) ?? "bilinmeyen",
      mesaj: (olay?.mesaj as string) ?? `Sunucu hatası (${res.status}).`,
    });
    sonuc.sureMs = performance.now() - t0;
    return sonuc;
  }

  if (!res.body) {
    sonuc.hatalar.push({ kind: "bilinmeyen", mesaj: "Sunucudan akış gelmedi." });
    sonuc.sureMs = performance.now() - t0;
    return sonuc;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let tampon = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
        sonuc.ham += olay.metin;
      } else if (olay.tip === "tool") {
        sonuc.toollar.push({
          isim: olay.isim,
          args: olay.args,
          sonuc: olay.sonuc,
          tur: olay.tur,
        });
      } else if (olay.tip === "kullanim") {
        sonuc.kullanim = {
          promptToken: olay.promptToken,
          completionToken: olay.completionToken,
          toolTuru: olay.toolTuru,
          usd: olay.usd,
        };
      } else if (olay.tip === "dogrulama") {
        sonuc.dogrulama = olay.sonuclar;
      } else if (olay.tip === "moderation") {
        sonuc.moderation = {
          flagged: olay.flagged,
          kategoriler: olay.kategoriler,
          gecikmeMs: olay.gecikmeMs,
        };
      } else if (olay.tip === "hata") {
        sonuc.hatalar.push({ kind: olay.kind, mesaj: olay.mesaj });
      }
      // "bitti" -> döngü doğal olarak biter (stream kapanır).
    }
  }

  sonuc.sureMs = performance.now() - t0;
  return sonuc;
}
