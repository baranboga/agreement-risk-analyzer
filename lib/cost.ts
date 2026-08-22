// lib/cost.ts
// -----------------------------------------------------------------------------
// Token sayımı ve USD maliyet hesabı.
// Prompt (girdi) ve completion (çıktı) token'ları AYRI fiyatlandırılır.
// Fiyatlar TEK bir sabit objede (FIYATLAR) tutulur; başka yerde fiyat yok.
// -----------------------------------------------------------------------------

// Fiyatlar: 1 MİLYON token başına USD. (OpenAI fiyatları bu birimde yayınlanır.)
//
// UYARI: Fiyatlar zamanla değişir. Buradaki değerler örnek/başlangıç
// değerleridir; güncel rakamları OpenAI'ın resmi pricing sayfasından
// doğrulayın. Tek yerde durduğu için güncellemesi kolaydır.
export const FIYATLAR = {
  "gpt-4.1": { girdi: 2.0, cikti: 8.0 },
  "gpt-4o": { girdi: 2.5, cikti: 10.0 },
  "gpt-4o-mini": { girdi: 0.15, cikti: 0.6 },
} as const;

// FIYATLAR'daki anahtarlar = desteklenen model adları.
export type ModelAdi = keyof typeof FIYATLAR;

/**
 * Prompt ve completion token sayısından toplam USD maliyeti hesaplar.
 * Girdi ve çıktı ayrı çarpanlarla hesaplanıp toplanır.
 */
export function maliyetHesapla(
  model: ModelAdi,
  promptToken: number,
  completionToken: number
): number {
  const f = FIYATLAR[model];
  const girdiUSD = (promptToken / 1_000_000) * f.girdi;
  const ciktiUSD = (completionToken / 1_000_000) * f.cikti;
  return girdiUSD + ciktiUSD;
}

/**
 * KABA canlı token tahmini (yalnızca ekrandaki "canlı" gösterge için).
 *
 * Neden gerekli: OpenAI streaming sırasında ara ara token sayısı VERMEZ;
 * kesin usage (prompt/completion) yalnızca akışın en sonunda gelir. Kullanıcı
 * akarken bir şey görsün diye ~4 karakter ≈ 1 token kaba oranıyla tahmin
 * üretiyoruz. Bu İngilizce ağırlıklı bir orandır; Türkçe'de biraz sapar.
 * Akış bitince bu tahmin, API'nin verdiği KESİN sayılarla değiştirilir.
 */
export function kabaTokenTahmini(metin: string): number {
  return Math.ceil(metin.length / 4);
}
