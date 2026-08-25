// lib/dogrula.ts
// -----------------------------------------------------------------------------
// ÇIKIŞ DOĞRULAMASI — modelin ürettiği "alinti" gerçekten kaynak metinde var mı?
//
// ===== SAVUNMA KATMANI 3 — ÇIKIŞ DOĞRULAMASI (deterministik) =================
// Bu katman HANGİ saldırıyı durdurur: A4 (veri sızdırma / uydurma alıntı) ve
//   modelin sözleşmede OLMAYAN bir metni "alıntı" diye üretmesini yakalar —
//   çünkü her alinti, kaynak metinde birebir aranır. Model sistem promptunu ya da
//   uydurma bir gerekçeyi "alıntı" gibi bassa, o alıntı kaynakta bulunamaz ve
//   İŞARETLENİR.
// Bu katman HANGİsini DURDURMAZ: A1/A3 gibi "gerçekten var olan bir maddeyi
//   yanlış (düşük) riskle raporlama" ya da "maddeleri sessizce eksiltme"
//   saldırılarını göremez — çünkü orada alıntı GERÇEKTEN metindedir; sorun risk
//   etiketinde/eksik maddede, alıntının varlığında değil. Bu katman "alıntı uydurma"
//   eksenine bakar; etiket/eksiltme eksenine değil.
// -----------------------------------------------------------------------------
//
// TASARIM: LLM KULLANMAYIZ. Doğrulama tamamen DETERMİNİSTİKtir (aynı girdi -> aynı
// sonuç), çünkü savunma katmanının kendisi modele güvenmemelidir. Yaklaşım:
//   1) Hem alıntıyı hem kaynağı AYNI şekilde normalize et (küçült, Türkçe
//      karakterleri ASCII'ye indir, noktalama + fazla boşluğu sadeleştir).
//   2) Basit substring (içerir mi) kontrolü yap.
// Böylece modelin "..." tırnakları, küçük noktalama/boşluk farkları, Türkçe
// karakter varyasyonları eşleşmeyi bozmaz; ama tamamen uydurulmuş bir cümle
// kaynakta bulunamaz.
//
// Doğrulanamayan madde SİLİNMEZ (bilinçli karar): sessizce silmek, bir saldırının
// olduğunu GİZLER. Bunun yerine madde "alintiDogrulandi=false" bayrağıyla işaretlenir
// ve UI'da kırmızı uyarı rozeti gösterilir.
// -----------------------------------------------------------------------------

/**
 * Metni karşılaştırmaya hazır "normal" biçime indirger.
 * Türkçe karakterler ASCII'ye foldlanır; noktalama ve boşluk tek boşluğa iner.
 * Hem alıntıya hem kaynağa AYNEN uygulanır; kıyas ancak böyle adil olur.
 */
export function normalizeMetin(s: string): string {
  return (
    s
      // Türkçe'ye özgü harfleri (büyük + küçük) ASCII karşılıklarına indir.
      // NOT: Bunu toLowerCase'den ÖNCE yapıyoruz; "İ".toLowerCase() JS'te
      // "i̇" (i + birleşik nokta) üretip eşleşmeyi bozabiliyor, o tuzağa düşmeyelim.
      .replace(/İ/g, "i")
      .replace(/I/g, "i")
      .replace(/ı/g, "i")
      .replace(/Ş/g, "s")
      .replace(/ş/g, "s")
      .replace(/Ğ/g, "g")
      .replace(/ğ/g, "g")
      .replace(/Ü/g, "u")
      .replace(/ü/g, "u")
      .replace(/Ö/g, "o")
      .replace(/ö/g, "o")
      .replace(/Ç/g, "c")
      .replace(/ç/g, "c")
      // Kalan büyük harfleri küçült.
      .toLowerCase()
      // Harf/rakam DIŞINDAKİ her şeyi (noktalama, tırnak, satır sonu, çoklu boşluk)
      // TEK boşluğa indir; sonra baş/son boşluğu at. Böylece "...", ".", ",", "\n"
      // gibi ufak farklar eşleşmeyi bozmaz.
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  );
}

/**
 * Bir alıntının kaynak metinde (normalize edilmiş biçimde) GEÇİP geçmediğini döner.
 * @param alinti     Modelin ürettiği alıntı.
 * @param kaynakMetin Kullanıcının verdiği ORİJİNAL sözleşme metni (sarmalsız).
 * @returns true -> alıntı kaynakta bulundu; false -> bulunamadı (uydurma olabilir).
 */
export function alintiDogrula(alinti: string, kaynakMetin: string): boolean {
  const a = normalizeMetin(alinti);
  // Boş/anlamsız alıntı doğrulanamaz -> güvenli tarafta kal, işaretle.
  if (a.length === 0) return false;
  const k = normalizeMetin(kaynakMetin);
  return k.includes(a);
}

/**
 * Madde listesindeki HER alıntıyı sırayla doğrular; boolean dizisi döndürür.
 * Dizi sırası maddeler ile birebir aynıdır (UI index'e göre eşler).
 */
export function maddeleriDogrula(
  maddeler: { alinti?: unknown }[],
  kaynakMetin: string
): boolean[] {
  return maddeler.map((m) =>
    alintiDogrula(typeof m?.alinti === "string" ? m.alinti : "", kaynakMetin)
  );
}
