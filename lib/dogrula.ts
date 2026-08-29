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
      // Unicode uyumluluk + kanonik birleştirme. Bu, "İ" yerine "I + birleşik
      // nokta", ayrışmış aksanlı harfler, tam-genişlik rakamlar, ligatürler gibi
      // GÖRSEL OLARAK AYNI ama kod olarak farklı biçimleri tek forma indirger;
      // böylece modelin kopyaladığı metin ile kaynak, bu farklardan ötürü sapmaz.
      .normalize("NFKC")
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
      // Birleşik/combining işaretleri (aksan, İ'nin ayrık noktası vb.) at.
      // NFKC sonrası kalan \p{M} parçaları eşleşmeyi bozmasın diye burada siliyoruz.
      .replace(/\p{M}+/gu, "")
      // Harf/rakam DIŞINDAKİ her şeyi (noktalama, tüm tırnak çeşitleri " " ' ' « »,
      // tire çeşitleri - – —, üç nokta … / ..., satır sonu, çoklu boşluk ve
      // sayı/noktalama arası boşluk) TEK boşluğa indir; sonra baş/son boşluğu at.
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  );
}

// -----------------------------------------------------------------------------
// GEVŞETİLMİŞ (3 SEVİYELİ) DOĞRULAMA — yalnızca TEŞHİS/GÖRÜNÜRLÜK içindir.
//
// Sunucu tarafı ölçüm (maddeleriDogrula -> boolean) DEĞİŞMEZ; bu katman ek olarak
// "tam | kismi | bulunamadi" seviyesi ve neyin neden uymadığını gösterecek teşhis
// verisi üretir. Böylece "temiz koşuda alıntı doğrulama dışı çıktı" durumunda
// SEBEBİ (model alıntıyı kısaltmış mı, uydurmuş mu) gözle görülebilir.
//
// - "tam"        : normalize edilmiş alıntı, normalize kaynağın ALT DİZGİSİ.
// - "kismi"      : alıntının kelimeleri kaynakta SIRAYLA (aralıklı olabilir) geçiyor
//                  — ör. model "(otuz)" gibi bir parçayı atlamış ya da … ile kısaltmış.
// - "bulunamadi" : ikisi de tutmuyor (alıntı büyük olasılıkla uydurma).
// -----------------------------------------------------------------------------

export type DogrulamaSeviyesi = "tam" | "kismi" | "bulunamadi";

export type DogrulamaTeshis = {
  seviye: DogrulamaSeviyesi;
  normalizeAlinti: string; // normalize edilmiş alıntı
  normalizeKaynakParca: string; // kaynakta en yakın/eşleşen normalize parça
  eslesenKelime: number; // kaç alıntı kelimesi kaynakta bulundu
  toplamKelime: number; // alıntının toplam kelime sayısı
};

/** Normalize edip boşluğa göre kelimelere böler (boşsa boş dizi). */
export function normalizeKelimeler(s: string): string[] {
  const n = normalizeMetin(s);
  return n.length ? n.split(" ") : [];
}

// qWords, sWords içinde SIRAYLA (aralıklı olabilir) geçiyorsa ilk/son eşleşme
// index'lerini döndürür; yoksa null. Greedy: ilk uyanı tutar (teşhis için yeter).
function altDiziAraligi(
  sWords: string[],
  qWords: string[]
): { bas: number; son: number } | null {
  if (qWords.length === 0) return null;
  let qi = 0;
  let bas = -1;
  for (let si = 0; si < sWords.length; si++) {
    if (sWords[si] === qWords[qi]) {
      if (qi === 0) bas = si;
      qi++;
      if (qi === qWords.length) return { bas, son: si };
    }
  }
  return null;
}

// Alıntı uzunluğunda kayan pencere içinde EN ÇOK ortak kelimeyi barındıran
// kaynak parçasını bulur (bulunamadı durumunda "en yakın parça"yı göstermek için).
function enYakinPencere(
  sWords: string[],
  qWords: string[]
): { parca: string; ortak: number } {
  if (qWords.length === 0 || sWords.length === 0) {
    return { parca: sWords.slice(0, 20).join(" "), ortak: 0 };
  }
  const qSet = new Set(qWords);
  const pencere = Math.min(qWords.length, sWords.length);
  let enIyiBas = 0;
  let enIyiOrtak = -1;
  for (let i = 0; i + pencere <= sWords.length; i++) {
    let ortak = 0;
    for (let j = i; j < i + pencere; j++) if (qSet.has(sWords[j])) ortak++;
    if (ortak > enIyiOrtak) {
      enIyiOrtak = ortak;
      enIyiBas = i;
    }
  }
  return {
    parca: sWords.slice(enIyiBas, enIyiBas + pencere).join(" "),
    ortak: Math.max(0, enIyiOrtak),
  };
}

/**
 * Bir alıntıyı 3 seviyede doğrular ve teşhis verisi döndürür (yalnızca görünürlük).
 */
export function alintiDogrulaDetay(
  alinti: string,
  kaynakMetin: string
): DogrulamaTeshis {
  const qn = normalizeMetin(alinti);
  const sn = normalizeMetin(kaynakMetin);
  const qWords = qn.length ? qn.split(" ") : [];
  const sWords = sn.length ? sn.split(" ") : [];

  // 1) TAM: birebir alt dizgi.
  if (qn.length > 0 && sn.includes(qn)) {
    return {
      seviye: "tam",
      normalizeAlinti: qn,
      normalizeKaynakParca: qn,
      eslesenKelime: qWords.length,
      toplamKelime: qWords.length,
    };
  }

  // 2) KISMI: kelimeler kaynakta sırayla geçiyor mu?
  const aralik = altDiziAraligi(sWords, qWords);
  if (aralik) {
    return {
      seviye: "kismi",
      normalizeAlinti: qn,
      normalizeKaynakParca: sWords.slice(aralik.bas, aralik.son + 1).join(" "),
      eslesenKelime: qWords.length,
      toplamKelime: qWords.length,
    };
  }

  // 3) BULUNAMADI: en yakın pencereyi göster.
  const yakin = enYakinPencere(sWords, qWords);
  return {
    seviye: "bulunamadi",
    normalizeAlinti: qn,
    normalizeKaynakParca: yakin.parca,
    eslesenKelime: yakin.ortak,
    toplamKelime: qWords.length,
  };
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
