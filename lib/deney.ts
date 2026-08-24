// lib/deney.ts
// -----------------------------------------------------------------------------
// DENEY (experiment) MODU — ortak kurulum.
//
// Amaç: "sureHesapla tool'unun tarifine konan kısıt, modelin tool'u çağırma
// oranını GERÇEKTEN değiştiriyor mu?" sorusunu ölçmek. Bunu üç koşulla test
// ederiz; koşullar arasında TEK değişen şey kısıt metninin NEREDE göründüğü:
//
//   A) Kısıt yok   -> ne tool description'da ne system prompt'ta
//   B) Sadece tool -> yalnızca sureHesapla'nın description'ında
//   C) Tool+system -> hem description'da hem system prompt'ta
//
// Metin, model, base system prompt ve tool şeması HER KOŞULDA AYNIDIR.
//
// Base system prompt TEK KAYNAKTAN gelir (lib/prompt.ts) — normal tarama ile
// deney A/B BİREBİR aynı prompt'u kullanır; deney C ise base'e kısıtı ekler.
//
// NOT (deneyin çalışması için ŞART): Base prompt, "başlangıç tarihi verilmemişse
// bugünü varsay" satırını içerir (üç koşulda da). Bu satır tool'u çağırmaya iten
// dürtüdür; onsuz — örnek sözleşmelerde somut tarih olmadığı için — zorunlu
// baslangicTarihi doldurulamaz ve model A'da bile hiç çağırmaz (0/N floor effect
// => ölçülecek bir şey kalmaz). Dürtü ortak olduğundan tek bağımsız değişken
// yine "kısıtın yeri"dir: B/C'deki kısıtın bu dürtüyü bastırıp bastırmadığını
// ölçeriz.
// -----------------------------------------------------------------------------

import { toolTanimlari } from "./tools";
import { sistemPromptu } from "./prompt";

// Üç deney koşulu.
export type DeneyKosulu = "A" | "B" | "C";

// TEK KAYNAK: kısıt metni yalnızca burada tanımlıdır. Hem tool tarifinde hem
// system prompt'ta BİREBİR AYNI string kullanılır (istenen davranış budur).
export const KISIT_METNI =
  "YALNIZCA metinde açık bir başlangıç tarihi (gün/ay/yıl) varken çağır; " +
  "başlangıç tarihi belirsizse bu tool'u ÇAĞIRMA.";

/**
 * Koşula göre tool tanımlarını üretir. Kısıt, B ve C koşullarında
 * sureHesapla'nın description'ının SONUNA eklenir; A'da hiç eklenmez.
 * parameters (JSON Schema) ve diğer her şey değişmeden kalır.
 */
export function deneyToollariniKur(kosul: DeneyKosulu) {
  const toolKisiti = kosul === "B" || kosul === "C";
  if (!toolKisiti) return toolTanimlari;

  return toolTanimlari.map((t) =>
    t.function.name === "sureHesapla"
      ? {
          ...t,
          function: {
            ...t.function,
            description: `${t.function.description} ${KISIT_METNI}`,
          },
        }
      : t
  );
}

/**
 * Koşula göre system prompt'u üretir.
 *
 * Base: kullanıcı deney UI'da düzenlediyse o metin (basePrompt); yoksa TEK
 * KAYNAKTAN (sistemPromptu) gelen varsayılan. Base üç koşulda da AYNIDIR (UI
 * onu kilitler). Kısıt yalnızca C'de, base'in SONUNA eklenir — düzenlenebilir
 * base ile de tutarlı olsun diye (varsayılanda da, özel metinde de aynı yer).
 *
 * @param bugun      Referans "bugün" (YYYY-MM-DD); yalnızca varsayılan base için.
 * @param basePrompt UI'dan gelen özel base; boş/verilmezse varsayılan kullanılır.
 */
export function deneySistemPromptu(
  kosul: DeneyKosulu,
  bugun: string,
  basePrompt?: string
): string {
  const base =
    basePrompt && basePrompt.trim() ? basePrompt : sistemPromptu(bugun);
  return kosul === "C" ? `${base}\n${KISIT_METNI}` : base;
}

// Bir deney taramasının (tek koşulda tek çalıştırma) ölçüm sonucu.
export type DeneySonucu = {
  toolCagriSayisi: number; // bu taramada kaç kez sureHesapla çağrıldı
  baslangicTarihleri: string[]; // çağrıldıysa gönderilen baslangicTarihi değerleri
  bulguSayisi: number; // nihai JSON'daki madde sayısı
  promptToken: number;
  completionToken: number;
  usd: number;
};
