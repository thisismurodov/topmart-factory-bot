import type {
  SaleInput,
  NoSaleInput,
  PaymentInput,
  NewShopInput,
} from "./fieldApi";
import { enqueueEvent } from "./eventQueue";
import { triggerSync } from "./syncEngine";

// Moslik qatlami: formalar avvalgidek enqueueSale/enqueueNoSale/... ni
// chaqiradi. Endi hodisa IndexedDB navbatiga (eventQueue) yoziladi va
// syncEngine uni fon rejimida yuboradi. "Avval saqla, keyin yubor" — forma
// navigatsiyadan OLDIN await qilishi shart (yozuv diskka tushganiga ishonch).

export async function enqueueSale(data: SaleInput): Promise<void> {
  await enqueueEvent("SALE", data);
  void triggerSync();
}

export async function enqueueNoSale(data: NoSaleInput): Promise<void> {
  await enqueueEvent("NO_SALE", data);
  void triggerSync();
}

export async function enqueuePayment(data: PaymentInput): Promise<void> {
  await enqueueEvent("PAYMENT", data);
  void triggerSync();
}

export async function enqueueNewShop(data: NewShopInput): Promise<void> {
  await enqueueEvent("NEW_SHOP", data);
  void triggerSync();
}

export { triggerSync };
