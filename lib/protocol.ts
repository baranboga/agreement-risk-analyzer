// lib/protocol.ts
// -----------------------------------------------------------------------------
// Sunucu -> istemci SSE (Server-Sent Events) sözleşmesi.
// Route ve client'ın AYNI tipleri kullanması için burada ortak tanım var.
//
// Her olay, tek satır JSON olarak şu biçimde gönderilir:
//   data: {"tip":"delta","metin":"..."}\n\n
// -----------------------------------------------------------------------------

export type SunucuOlayi =
  // İçerik parçası. Hem mod A (birikip sonda parse) hem mod B (canlı kart)
  // bu deltaları kullanır.
  | { tip: "delta"; metin: string }
  // Bir tool çalıştırıldı (UI'da tool turlarını göstermek için).
  | {
      tip: "tool";
      isim: string;
      args: unknown;
      sonuc: string;
      tur: number; // kaçıncı döngü turunda çalıştı
    }
  // KESİN token/maliyet bilgisi (akışın sonunda API'den gelen usage'a göre).
  | {
      tip: "kullanim";
      promptToken: number;
      completionToken: number;
      toolTuru: number;
      usd: number;
    }
  // ÇIKIŞ DOĞRULAMASI sonucu (bkz. lib/dogrula.ts). sonuclar[i], i. maddenin
  // alıntısının kaynak metinde bulunup bulunmadığıdır (maddeler ile AYNI sıra).
  // false olan maddede UI kırmızı "alıntı doğrulanamadı" rozeti gösterir.
  // Akışın sonunda, nihai JSON hazır olunca TEK sefer gönderilir.
  | { tip: "dogrulama"; sonuclar: boolean[] }
  // MODERATION sonucu (opsiyonel; yalnızca istekte moderasyon=true ise gelir).
  // Girdi ENGELLENMEZ, sadece işaretlenir. gecikmeMs bu çağrının eklediği süredir.
  | {
      tip: "moderation";
      flagged: boolean | null; // null -> çağrı yapılamadı/başarısız
      kategoriler: string[];
      gecikmeMs: number;
      hata?: string;
    }
  // Hata. kind alanı ana durumları ayırır (istenildiği gibi ayrı mesajlar):
  //   rate_limit     -> 429, hız sınırı
  //   gecersiz_json  -> model geçerli JSON üretemedi
  //   tool_hatasi    -> tool çalışırken hata
  //   gecersiz_girdi -> istek gövdesi giriş doğrulamasından geçemedi (400)
  //   bilinmeyen     -> diğer her şey
  | {
      tip: "hata";
      kind:
        | "rate_limit"
        | "gecersiz_json"
        | "tool_hatasi"
        | "gecersiz_girdi"
        | "bilinmeyen";
      mesaj: string;
    }
  // Akış bitti; client döngüsünü kapatabilir.
  | { tip: "bitti" };
