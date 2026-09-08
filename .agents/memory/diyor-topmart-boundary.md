---
name: Diyor Mahsulotlari ERP and Top Mart boundary
description: Confirmed business identity, catalog flags, C-03 ownership, and Telegram vehicle-label lifecycle.
---

Diyor Mahsulotlari ERP is the factory system. Top Mart is Diyor Mahsulotlari's own fixed distributor/customer, mapped to the canonical C-03 finished-goods warehouse rather than a user-selectable customer or warehouse.

**Why:** The user explicitly separated factory accounting from distribution accounting. A Diyor-to-Top-Mart sale is a real completed ERP sale and credits C-03; agent-to-shop sales remain only in Top Mart distribution analytics.

**How to apply:** Keep Top Mart/C-03 configuration read-only and fail closed if either identity changes. Diyor products retain their production flag; Top-Mart-only external products are sellable but must stay out of factory production.

Vehicle loading is Telegram-first and limited to an omborchi role (admins may also operate it). A new barcode label is generated for each physical package using the product's package capacity; operator-entered quantity and total kg are allocated across those labels.

**Why:** This final policy supersedes the earlier plan to reuse production barcodes during vehicle loading.

**How to apply:** Preparing or printing labels never moves inventory. C-03 decreases and vehicle stock increases only after the final physical stock-transfer confirmation. Preserve authentic historical handoffs in their stored generated/existing mode; never blanket-backfill label modes.