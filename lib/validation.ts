// lib/validation.ts
// -----------------------------------------------------------------------------
// GİRİŞ DOĞRULAMASI — /api/analyze istek gövdesinin şeması (zod).
//
// Neden ayrı dosya: route "ince" kalsın. Route yalnızca istekDogrula() çağırır;
// hangi alanın neden reddedildiği kararı burada, tek yerde durur.
//
// Şema:
//   - metin      : string, EN AZ 1, EN FAZLA 60_000 karakter (zorunlu).
//   - model      : opsiyonel; verilirse SADECE FIYATLAR anahtarlarından biri
//                  (fiyat tablosunda karşılığı olmayan model kabul edilmez).
//   - savunma    : opsiyonel bool (prompt injection savunması açık mı). Vars: false.
//   - moderasyon : opsiyonel bool (moderation ölçümü açık mı). Vars: false.
//
// Not: savunma/moderasyon şemaya EKLENDİ ki route içinde ayrıca elle
// ayrıştırmayalım — tek doğrulama noktası burası olsun.
// -----------------------------------------------------------------------------

import { z } from "zod";
import { FIYATLAR, type ModelAdi } from "./cost";

// Desteklenen model adları = FIYATLAR anahtarları (TEK KAYNAK). z.enum literal
// tuple ister; FIYATLAR anahtarlarından türetip ModelAdi olarak daraltıyoruz.
const MODEL_ADLARI = Object.keys(FIYATLAR) as [ModelAdi, ...ModelAdi[]];

export const AnalizIstekSchema = z.object({
  metin: z
    .string({ required_error: "metin alanı zorunludur." })
    .min(1, "metin boş olamaz (en az 1 karakter).")
    .max(60_000, "metin çok uzun (en fazla 60.000 karakter)."),
  model: z
    .enum(MODEL_ADLARI, {
      errorMap: () => ({
        message: `model bilinmiyor; izin verilenler: ${MODEL_ADLARI.join(", ")}.`,
      }),
    })
    .optional(),
  savunma: z.boolean().optional().default(false),
  moderasyon: z.boolean().optional().default(false),
});

export type AnalizIstek = z.infer<typeof AnalizIstekSchema>;

// istekDogrula sonucu: ayrık birlik. basarili=true ise "veri" hazırdır;
// aksi halde "mesaj" kullanıcıya gösterilecek net hata metnidir.
export type DogrulamaSonucu =
  | { basarili: true; veri: AnalizIstek }
  | { basarili: false; mesaj: string };

/**
 * İstek gövdesini doğrular. Hata durumunda HANGİ alanın NEDEN reddedildiğini
 * söyleyen okunur bir mesaj üretir (route bunu 400 + hata olayı olarak döner).
 */
export function istekDogrula(govde: unknown): DogrulamaSonucu {
  const r = AnalizIstekSchema.safeParse(govde);
  if (r.success) return { basarili: true, veri: r.data };

  // Tüm sorunları "alan: sebep" biçiminde birleştir.
  const ayrinti = r.error.issues
    .map((i) => {
      const alan = i.path.length ? i.path.join(".") : "(gövde)";
      return `${alan}: ${i.message}`;
    })
    .join("; ");

  return { basarili: false, mesaj: `Girdi reddedildi — ${ayrinti}` };
}
