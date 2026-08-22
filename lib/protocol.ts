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
  // Hata. kind alanı üç ana durumu ayırır (istenildiği gibi ayrı mesajlar):
  //   rate_limit    -> 429, hız sınırı
  //   gecersiz_json -> model geçerli JSON üretemedi
  //   tool_hatasi   -> tool çalışırken hata
  //   bilinmeyen    -> diğer her şey
  | {
      tip: "hata";
      kind: "rate_limit" | "gecersiz_json" | "tool_hatasi" | "bilinmeyen";
      mesaj: string;
    }
  // Akış bitti; client döngüsünü kapatabilir.
  | { tip: "bitti" };
