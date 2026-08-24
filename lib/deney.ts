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
// NOT (deneyin çalışması için ŞART): Base system prompt, "başlangıç tarihi
// verilmemişse bugünü varsay" satırını ÜÇ KOŞULDA DA içerir. Bu satır tool'u
// çağırmaya iten dürtüdür; onsuz — örnek sözleşmelerde somut tarih olmadığı
// için — zorunlu baslangicTarihi doldurulamaz ve model A'da bile hiç çağırmaz
// (0/N floor effect => ölçülecek bir şey kalmaz). Dürtü ortak olduğundan tek
// bağımsız değişken yine "kısıtın yeri"dir: B/C'deki kısıtın, bu ortak dürtüyü
// bastırıp bastırmadığını ölçeriz.
// -----------------------------------------------------------------------------

import { toolTanimlari } from "./tools";

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
 * Koşula göre system prompt'u üretir. Base prompt üç koşulda da AYNIDIR
 * ("bugünü varsay" dürtüsü dahil); kısıt yalnızca C'de, tool kullanım
 * talimatının hemen ardına eklenir.
 *
 * @param bugun Referans "bugün" tarihi (YYYY-MM-DD). İstek anında hesaplanıp
 *              geçilir; fonksiyon saf kalsın diye içeride üretilmez.
 */
export function deneySistemPromptu(kosul: DeneyKosulu, bugun: string): string {
  const satirlar: string[] = [
    "Sen deneyimli bir Türk sözleşme hukuku analistisin.",
    "Sana verilen sözleşme metnini incele ve RİSK içeren maddeleri tespit et.",
    "",
    "Her bulgu için şunları üret:",
    "- alinti: sözleşmeden birebir KISA alıntı",
    '- riskSeviyesi: "dusuk" | "orta" | "yuksek"',
    "- gerekce: maddenin neden riskli olduğu",
    "- oneri: riski azaltmak için somut öneri",
    "- sureIfadesi: madde bir süreye/tarihe bağlıysa ilgili not; değilse null",
    "",
    "Bir süre/son tarih hesaplaman gerekiyorsa 'sureHesapla' TOOL'unu kullan.",
    // ÜÇ KOŞULDA DA ORTAK dürtü: A'nın tabanı sıfır kalmasın (bkz. dosya başı NOT).
    `Somut bir başlangıç tarihi verilmemişse bugünü (${bugun}) başlangıç kabul et.`,
  ];

  // Koşul C: kısıt system prompt'a da eklenir.
  if (kosul === "C") satirlar.push(KISIT_METNI);

  satirlar.push(
    "",
    "Sadece gerçekten riskli maddeleri raporla. Çıktıyı verilen JSON şemasına",
    "UYGUN üret; şema dışı alan ekleme."
  );

  return satirlar.join("\n");
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
