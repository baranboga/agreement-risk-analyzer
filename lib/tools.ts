// lib/tools.ts
// -----------------------------------------------------------------------------
// Modelin çağırabileceği YEREL fonksiyonlar (tool'lar) burada.
// Şimdilik tek tool var: sureHesapla.
//
// Üç parça:
//   1) sureHesapla        -> asıl iş yapan saf fonksiyon
//   2) toolTanimlari      -> OpenAI'a gönderilecek tool şeması (JSON)
//   3) toolCalistir       -> isim + argüman alıp doğru fonksiyonu çağıran dağıtıcı
// -----------------------------------------------------------------------------

/**
 * Bir başlangıç tarihine gün ekleyip bitiş tarihini ISO (YYYY-MM-DD) döndürür.
 *
 * @param baslangicTarihi "YYYY-MM-DD" formatında tarih (ör. imza günü)
 * @param gunSayisi       eklenecek gün sayısı (0 veya pozitif tam sayı)
 * @param tur             "takvim" -> her günü sayar
 *                        "is"     -> sadece iş günü sayar (Cmt + Paz atlanır)
 *
 * !!! ÖNEMLİ SINIRLAMA !!!
 * Bu fonksiyon TÜRKİYE RESMİ TATİLLERİNİ BİLMEZ. "is" (iş günü) modunda
 * yalnızca HAFTA SONLARINI (Cumartesi + Pazar) atlar. 23 Nisan, 19 Mayıs,
 * 29 Ekim, dini bayramlar (Ramazan/Kurban) gibi resmi tatiller burada
 * "iş günü" sayılır. Bu yüzden sonuç, gerçek yasal süreden BİRKAÇ GÜN
 * SAPABİLİR. Kritik hukuki süre hesaplarında tek başına güvenilmemelidir.
 */
export function sureHesapla(
  baslangicTarihi: string,
  gunSayisi: number,
  tur: "takvim" | "is"
): string {
  // Tarihi UTC olarak kur: yerel saat dilimi kaymaları sonucu bozmasın.
  const d = new Date(`${baslangicTarihi}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `Geçersiz tarih: "${baslangicTarihi}" (beklenen format: YYYY-MM-DD)`
    );
  }
  if (!Number.isInteger(gunSayisi) || gunSayisi < 0) {
    throw new Error(`Geçersiz gün sayısı: ${gunSayisi} (0 veya pozitif tam sayı olmalı)`);
  }

  if (tur === "takvim") {
    // Takvim günü: dümdüz ekle.
    d.setUTCDate(d.getUTCDate() + gunSayisi);
  } else {
    // İş günü: her seferinde 1 gün ilerle; hafta sonuysa saymadan geç.
    let kalan = gunSayisi;
    while (kalan > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      const gun = d.getUTCDay(); // 0 = Pazar, 6 = Cumartesi
      const haftaSonu = gun === 0 || gun === 6;
      if (!haftaSonu) {
        kalan--;
      }
    }
  }

  // Yalnızca tarih kısmını (YYYY-MM-DD) döndür.
  return d.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// OpenAI'a gönderilecek tool tanımı (Chat Completions "tools" formatı).
// parameters kısmı JSON Schema'dır; modelin argümanları buna göre üretmesini
// bekleriz.
// -----------------------------------------------------------------------------
export const toolTanimlari = [
  {
    type: "function",
    function: {
      name: "sureHesapla",
      description:
        "Bir başlangıç tarihine gün ekleyerek son/bitiş tarihini hesaplar. " +
        "Sözleşmedeki 'imzadan itibaren 30 gün içinde', 'teslimden 15 iş günü " +
        "sonra' gibi süre ifadelerini somut bir tarihe çevirmek için kullan.",
      parameters: {
        type: "object",
        properties: {
          baslangicTarihi: {
            type: "string",
            description: "Başlangıç tarihi (YYYY-MM-DD).",
          },
          gunSayisi: {
            type: "integer",
            description: "Eklenecek gün sayısı.",
          },
          tur: {
            type: "string",
            enum: ["takvim", "is"],
            description:
              "'takvim' tüm günleri sayar; 'is' sadece iş günlerini (hafta sonu hariç) sayar.",
          },
        },
        required: ["baslangicTarihi", "gunSayisi", "tur"],
        additionalProperties: false,
      },
    },
  },
] as const;

/**
 * Tool ismine göre gerçek fonksiyonu çalıştıran dağıtıcı (dispatcher).
 * Sonucu, modele tool mesajı olarak geri vereceğimiz için STRING döndürür.
 * Bilinmeyen tool veya çalışma hatası -> throw eder; çağıran yerde yakalanır.
 */
export function toolCalistir(isim: string, args: unknown): string {
  switch (isim) {
    case "sureHesapla": {
      const a = args as {
        baslangicTarihi: string;
        gunSayisi: number;
        tur: "takvim" | "is";
      };
      const bitisTarihi = sureHesapla(a.baslangicTarihi, a.gunSayisi, a.tur);
      // Modele yapılandırılmış bir cevap dön; ham string yerine JSON daha net.
      return JSON.stringify({ bitisTarihi });
    }
    default:
      throw new Error(`Bilinmeyen tool: ${isim}`);
  }
}
