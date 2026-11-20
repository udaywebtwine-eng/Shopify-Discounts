/**
 * StackUp Bundles - Storefront Interactivity
 * Supports Single & Multi-Product Bundles with Dynamic Pricing, Variant Changes, Stock Alerts, and Direct Checkout.
 */

(function () {
  'use strict';

  // Shared Currency & String Helpers
  function formatMoney(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function cleanVariantId(id) {
    if (!id) return '';
    const str = String(id).trim();
    if (str.startsWith('sample')) return str;
    return str.replace(/\D/g, '');
  }

  function initStackUpPairedWidgets() {
    const widgets = document.querySelectorAll('.stackup-paired-widget');
    if (!widgets || widgets.length === 0) return;
    widgets.forEach((widget) => {
      widget.style.removeProperty('display');
      if (widget.dataset.initialized) return;
      widget.dataset.initialized = 'true';

      const mainItem = widget.querySelector('.stackup-main-item');
      const subItems = widget.querySelectorAll('.stackup-sub-item');
      const finalPriceElem = widget.querySelector('.stackup-final-price');
      const originalPriceElem = widget.querySelector('.stackup-original-price');
      const savingsPill = widget.querySelector('.stackup-savings-pill');
      const savingsTextElem = widget.querySelector('.stackup-savings-text');
      const addBtn = widget.querySelector('.stackup-add-button');
      const btnText = widget.querySelector('.stackup-btn-text');
      const btnIcon = widget.querySelector('.stackup-btn-icon');
      const btnSpinner = widget.querySelector('.stackup-btn-spinner');
      const stockAlert = widget.querySelector('.stackup-stock-alert');
      const alertText = widget.querySelector('.stackup-alert-text');
      const mainBadge = widget.querySelector('.main-stock-badge');

      const discountPercentage = parseFloat(widget.dataset.discountPercentage) || 0;
      const customBtnText = widget.dataset.customBtnText?.trim() || '';

      function updatePrices() {
        const mainQty = parseInt(widget.dataset.mainQuantity) || 1;
        const mainUnitPrice = parseFloat(mainItem?.dataset?.price) || 0;
        const mainLinePriceCents = mainUnitPrice * mainQty;

        // Update Main Product Price Display
        const mainPriceElem = widget.querySelector('.stackup-main-price');
        const mainUnitElem = widget.querySelector('.stackup-main-unit-price');
        if (mainPriceElem) {
          mainPriceElem.textContent = formatMoney(mainLinePriceCents);
        }
        if (mainUnitElem && mainQty > 1) {
          mainUnitElem.textContent = '(' + formatMoney(mainUnitPrice) + ' each)';
        }

        // ============================================
        // Process All Sub Products in the Bundle
        // ============================================
        let totalSubPriceCents = 0;
        let checkedSubCount = 0;
        const checkedItemsForCart = [];
        const outOfStockCheckedTitles = [];

        subItems.forEach((subItem) => {
          const checkbox = subItem.querySelector('.stackup-item-check[data-role="sub"]');
          const select = subItem.querySelector('.stackup-variant-select');
          const priceElem = subItem.querySelector('.stackup-sub-price');
          const unitElem = subItem.querySelector('.stackup-sub-unit-price');
          const stockBadge = subItem.querySelector('.sub-stock-badge');
          const subQty = parseInt(subItem.dataset.quantity) || 1;
          const subTitle = subItem.dataset.title || 'Paired product';

          const isChecked = checkbox ? checkbox.checked : true;


          // Read variant details
          let subUnitPrice = 0;
          let subVariantId = null;
          let isSubAvailable = true;

          if (select) {
            if (select.tagName === 'SELECT') {
              const selectedOpt = select.options[select.selectedIndex];
              subUnitPrice = parseFloat(selectedOpt?.dataset?.price) || 0;
              subVariantId = select.value;
              if (selectedOpt && selectedOpt.dataset.available === 'false') {
                isSubAvailable = false;
              }
            } else {
              subUnitPrice = parseFloat(select.dataset?.price) || 0;
              subVariantId = select.value;
              if (select.dataset?.available === 'false') {
                isSubAvailable = false;
              }
            }
          }

          const subLinePriceCents = subUnitPrice * subQty;

          if (priceElem) {
            priceElem.textContent = formatMoney(subLinePriceCents);
          }
          if (unitElem && subQty > 1) {
            unitElem.textContent = '(' + formatMoney(subUnitPrice) + ' each)';
          }

          // Stock Badge Indicator for Sub Item
          if (!isSubAvailable) {
            subItem.classList.add('is-out-of-stock');
            if (stockBadge) stockBadge.style.display = 'inline-flex';
          } else {
            subItem.classList.remove('is-out-of-stock');
            if (stockBadge) stockBadge.style.display = 'none';
          }

          // Accumulate if checked
          if (isChecked) {
            checkedSubCount++;
            totalSubPriceCents += subLinePriceCents;
            checkedItemsForCart.push({
              id: subVariantId,
              quantity: subQty,
              title: subTitle,
            });

            if (!isSubAvailable) {
              outOfStockCheckedTitles.push(subTitle);
            }
          }
        });

        // Store selected items on the add button for checkout submission
        if (addBtn) {
          addBtn._checkedItems = checkedItemsForCart;
        }

        // ============================================
        // Calculate Totals & Bundle Discount
        // ============================================
        const totalCheckedCount = 1 + checkedSubCount;
        let originalTotal = mainLinePriceCents;
        let finalTotal = mainLinePriceCents;

        if (checkedSubCount > 0) {
          // Bundle discount applies across main item + all checked sub items
          originalTotal = mainLinePriceCents + totalSubPriceCents;
          const discountMultiplier = (100 - discountPercentage) / 100;
          finalTotal = Math.round(originalTotal * discountMultiplier);

          if (originalPriceElem) {
            originalPriceElem.textContent = formatMoney(originalTotal);
            originalPriceElem.style.display = discountPercentage > 0 ? 'inline' : 'none';
          }

          if (savingsPill && savingsTextElem && discountPercentage > 0) {
            const savingsCents = originalTotal - finalTotal;
            savingsTextElem.textContent = 'Save ' + formatMoney(savingsCents) + ' (' + discountPercentage + '% OFF)';
            savingsPill.style.display = 'inline-flex';
          }
        } else {
          // Only main product is selected -> No bundle discount
          originalTotal = mainLinePriceCents;
          finalTotal = mainLinePriceCents;

          if (originalPriceElem) {
            originalPriceElem.style.display = 'none';
          }
          if (savingsPill) {
            savingsPill.style.display = 'none';
          }
        }

        if (finalPriceElem) {
          finalPriceElem.textContent = formatMoney(finalTotal);
        }

        // Single plus divider between main product and subproducts
        const plusWrap = widget.querySelector('.stackup-plus-wrap');
        if (plusWrap) {
          if (checkedSubCount === 0) {
            plusWrap.style.opacity = '0.4';
          } else {
            plusWrap.style.opacity = '1';
          }
        }

        // ============================================
        // Check Out of Stock / Availability Conditions
        // ============================================
        let isMainAvailable = true;
        if (mainItem && mainItem.dataset.available === 'false') {
          isMainAvailable = false;
        }
        const themeAddBtn = document.querySelector('form[action*="/cart/add"] button[type="submit"][name="add"], form[action*="/cart/add"] [name="add"]');
        if (themeAddBtn && themeAddBtn.disabled && /sold\s*out|out\s*of\s*stock|unavailable/i.test(themeAddBtn.textContent || '')) {
          isMainAvailable = false;
        }

        // Update main item visual indicator
        if (mainItem) {
          if (!isMainAvailable) {
            mainItem.classList.add('is-out-of-stock');
            if (mainBadge) mainBadge.style.display = 'inline-flex';
          } else {
            mainItem.classList.remove('is-out-of-stock');
            if (mainBadge) mainBadge.style.display = 'none';
          }
        }

        const isMainBlocked = !isMainAvailable;
        const isSubBlocked = outOfStockCheckedTitles.length > 0;

        if (isMainBlocked || isSubBlocked) {
          if (addBtn) {
            addBtn.disabled = true;
            addBtn.classList.add('is-out-of-stock-btn');
          }
          if (btnText) {
            btnText.textContent = 'Out of Stock';
          }

          let msg = 'This product is out of stock, not available.';
          const mainTitle = mainItem?.dataset?.title || 'Main product';

          if (isMainBlocked && isSubBlocked) {
            msg = 'Main product and selected bundle items are currently out of stock.';
          } else if (isMainBlocked) {
            msg = `${mainTitle} is out of stock, not available.`;
          } else if (isSubBlocked) {
            if (outOfStockCheckedTitles.length === 1) {
              msg = `${outOfStockCheckedTitles[0]} is out of stock, not available. Uncheck it to buy the remaining items.`;
            } else {
              msg = `${outOfStockCheckedTitles.join(', ')} are out of stock. Uncheck them to buy the remaining items.`;
            }
          }

          if (stockAlert && alertText) {
            alertText.textContent = msg;
            stockAlert.style.display = 'flex';
          }
        } else {
          // All checked items are in stock
          if (addBtn) {
            addBtn.disabled = false;
            addBtn.classList.remove('is-out-of-stock-btn');
          }
          if (stockAlert) {
            stockAlert.style.display = 'none';
          }

          // Dynamic Button Text
          let dynamicText = '';
          if (totalCheckedCount >= 3) {
            dynamicText = `Add All ${totalCheckedCount} to Cart`;
          } else if (totalCheckedCount === 2) {
            dynamicText = 'Add Both to Cart';
          } else {
            dynamicText = 'Add to Cart';
          }

          if (customBtnText && !customBtnText.startsWith('Add All') && !customBtnText.startsWith('Add Both')) {
            dynamicText = customBtnText;
          }

          if (btnText) {
            btnText.textContent = dynamicText;
          }
          if (addBtn) {
            addBtn.dataset.originalText = dynamicText;
          }
        }
      }

      // ============================================
      // Attach Listeners to All Sub Items
      // ============================================
      subItems.forEach((subItem) => {
        const checkbox = subItem.querySelector('.stackup-item-check[data-role="sub"]');
        const select = subItem.querySelector('.stackup-variant-select');

        if (checkbox) {
          checkbox.addEventListener('change', updatePrices);
        }
        if (select) {
          select.addEventListener('change', updatePrices);
        }
      });

      // Listen to variant changes on the main product form
      const mainProductForm = document.querySelector('form[action*="/cart/add"]');
      if (mainProductForm) {
        mainProductForm.addEventListener('change', () => {
          setTimeout(updatePrices, 80);
        });
      }
      document.addEventListener('variant:change', () => {
        setTimeout(updatePrices, 80);
      });
      if (window.PUB_SUB_EVENTS && typeof window.subscribe === 'function') {
        try {
          window.subscribe(window.PUB_SUB_EVENTS.variantChange, (event) => {
            const variant = event?.data?.variant;
            if (variant && mainItem) {
              mainItem.dataset.available = variant.available ? 'true' : 'false';
              mainItem.dataset.price = variant.price;
              const variantElem = widget.querySelector('.stackup-item-variant');
              if (variantElem && variant.title && variant.title !== 'Default Title') {
                variantElem.textContent = variant.title;
              }
            }
            updatePrices();
          });
        } catch (e) {
          // Ignore pubsub subscription error
        }
      }

      // Initial calculation
      updatePrices();

      // ============================================
      // 1-Click Direct Clean Checkout Action
      // ============================================
      if (addBtn) {
        addBtn.addEventListener('click', async function (e) {
          e.preventDefault();
          if (addBtn.disabled) return;

          // Attempt to read currently selected main variant from active product form
          const mainFormInput = document.querySelector('form[action*="/cart/add"] input[name="id"]');
          const mainVariantId = mainFormInput?.value || addBtn.dataset.mainVariant;
          const mainQty = parseInt(widget.dataset.mainQuantity) || 1;

          // Guard against Theme Editor preview with sample data
          const isSamplePreview = mainVariantId === 'preview' || (addBtn._checkedItems || []).some((item) => item.id === 'sample');
          if (isSamplePreview) {
            if (stockAlert && alertText) {
              alertText.textContent = 'Theme Editor Preview: Sample bundle items cannot be added to cart. Please test on an active bundle product.';
              stockAlert.style.display = 'flex';
            }
            return;
          }

          const itemsToAdd = [];
          if (mainVariantId && mainVariantId !== 'preview') {
            itemsToAdd.push({ id: mainVariantId, quantity: mainQty });
          }

          // Add all currently checked sub items
          if (Array.isArray(addBtn._checkedItems)) {
            for (const item of addBtn._checkedItems) {
              if (item.id && item.id !== 'sample') {
                itemsToAdd.push({ id: item.id, quantity: item.quantity });
              }
            }
          }

          if (itemsToAdd.length === 0) return;

          // UI Loading state - show ONLY the spinner
          addBtn.disabled = true;
          if (btnIcon) btnIcon.style.display = 'none';
          if (btnText) btnText.style.display = 'none';
          if (btnSpinner) btnSpinner.style.display = 'inline-flex';
          if (stockAlert) stockAlert.style.display = 'none';

          try {
            const rootUrl = window.Shopify?.routes?.root || '/';

            // 1. Clear previous cart items and conflicting discounts
            await fetch(`${rootUrl}cart/clear.js`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
            });

            // 2. Add exclusively the selected bundle items
            const addResponse = await fetch(`${rootUrl}cart/add.js`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify({
                items: itemsToAdd,
              }),
            });

            const responseData = await addResponse.json().catch(() => ({}));

            if (!addResponse.ok) {
              console.error('[StackUp] Cart add error response:', responseData);
              throw new Error(responseData.description || responseData.message || 'This product is out of stock, not available.');
            }

            // 3. Directly redirect to Shopify checkout
            window.location.href = `${rootUrl}checkout`;
            return;
          } catch (err) {
            console.error('[StackUp] Add to cart error:', err);
            const errorMsg = err.message || 'This product is out of stock, not available.';
            if (stockAlert && alertText) {
              alertText.textContent = errorMsg;
              stockAlert.style.display = 'flex';
            }
            if (addBtn) {
              addBtn.disabled = true;
              addBtn.classList.add('is-out-of-stock-btn');
            }
            if (btnText) {
              btnText.textContent = 'Unavailable';
            }
            setTimeout(() => {
              updatePrices();
            }, 4000);
          } finally {
            if (btnSpinner) btnSpinner.style.display = 'none';
            if (btnIcon) btnIcon.style.display = 'inline-flex';
            if (btnText) btnText.style.display = '';
            if (!stockAlert || stockAlert.style.display === 'none') {
              addBtn.disabled = false;
              addBtn.classList.remove('is-out-of-stock-btn');
            }
          }
        });
      }
    });
  }

  // ==========================================================================
  // StackUp - Special Add-Ons / Selected Products Widget Logic
  // ==========================================================================

  function initStackUpAddonsWidgets() {
    const widgets = document.querySelectorAll('.stackup-addons-widget');
    if (!widgets || widgets.length === 0) return;

    widgets.forEach((widget) => {
      widget.style.removeProperty('display');
      if (widget.dataset.initialized === 'true') return;
      widget.dataset.initialized = 'true';

      const discountPercentage = parseFloat(widget.dataset.discountPercentage) || 0;
      const items = widget.querySelectorAll('.stackup-addon-item');
      const finalPriceElem = widget.querySelector('.stackup-addons-final-price');
      const originalPriceElem = widget.querySelector('.stackup-addons-original-price');
      const savingsPill = widget.querySelector('.stackup-addons-savings-pill');
      const savingsTextElem = widget.querySelector('.stackup-addons-savings-text');
      const addBtn = widget.querySelector('.stackup-addons-add-btn');
      const btnText = widget.querySelector('.stackup-addons-btn-text');
      const stockAlert = widget.querySelector('.stackup-addons-stock-alert');
      const alertText = widget.querySelector('.stackup-addons-alert-text');
      const customBtnText = widget.dataset.customBtnText?.trim() || '';

      function updateAddonsSummary() {
        let totalDiscountedCents = 0;
        let totalOriginalCents = 0;
        let checkedCount = 0;
        const checkedAddonsForCart = [];
        const outOfStockCheckedTitles = [];

        items.forEach((item) => {
          const checkbox = item.querySelector('.stackup-addon-checkbox');
          const select = item.querySelector('.stackup-addon-variant-select');
          const discountedPriceElem = item.querySelector('.stackup-addon-discounted-price');
          const originalPriceElem = item.querySelector('.stackup-addon-original-price');
          const unitPriceElem = item.querySelector('.stackup-unit-price');
          const stockBadge = item.querySelector('.addon-stock-badge');
          const qty = parseInt(item.dataset.quantity || '1', 10) || 1;
          const title = item.dataset.title || 'Add-on';

          const isChecked = checkbox ? checkbox.checked : true;


          let unitOrigPrice = 0;
          let unitDiscPrice = 0;
          let variantId = null;
          let isAvailable = true;

          if (select) {
            if (select.tagName === 'SELECT') {
              const selectedOpt = select.options[select.selectedIndex];
              unitOrigPrice = parseFloat(selectedOpt?.dataset?.price) || parseFloat(item.dataset.price) || 0;
              unitDiscPrice = parseFloat(selectedOpt?.dataset?.discountedPrice) || parseFloat(item.dataset.discountedPrice) || Math.round(unitOrigPrice * (1 - discountPercentage / 100));
              variantId = select.value || item.dataset.variantId;
              if (selectedOpt && selectedOpt.dataset.available === 'false') {
                isAvailable = false;
              }
            } else {
              unitOrigPrice = parseFloat(select.dataset?.price) || parseFloat(item.dataset.price) || 0;
              unitDiscPrice = parseFloat(select.dataset?.discountedPrice) || parseFloat(item.dataset.discountedPrice) || Math.round(unitOrigPrice * (1 - discountPercentage / 100));
              variantId = select.value || item.dataset.variantId;
              if (select.dataset?.available === 'false') {
                isAvailable = false;
              }
            }
          } else {
            unitOrigPrice = parseFloat(item.dataset.price) || 0;
            unitDiscPrice = parseFloat(item.dataset.discountedPrice) || Math.round(unitOrigPrice * (1 - discountPercentage / 100));
            variantId = item.dataset.variantId;
          }

          const lineOrigCents = unitOrigPrice * qty;
          const lineDiscCents = unitDiscPrice * qty;

          if (discountedPriceElem) {
            discountedPriceElem.textContent = formatMoney(lineDiscCents);
          }
          if (originalPriceElem) {
            originalPriceElem.textContent = formatMoney(lineOrigCents);
          }
          if (unitPriceElem && qty > 1) {
            unitPriceElem.textContent = '(' + formatMoney(unitDiscPrice) + ' each)';
          }

          if (!isAvailable) {
            item.classList.add('is-out-of-stock');
            if (stockBadge) stockBadge.style.display = 'inline-flex';
          } else {
            item.classList.remove('is-out-of-stock');
            if (stockBadge) stockBadge.style.display = 'none';
          }

          if (isChecked) {
            checkedCount++;
            totalOriginalCents += lineOrigCents;
            totalDiscountedCents += lineDiscCents;
            checkedAddonsForCart.push({
              id: variantId,
              quantity: qty,
              title: title,
            });

            if (!isAvailable) {
              outOfStockCheckedTitles.push(title);
            }
          }
        });

        // Store checked add-ons on widget
        widget._checkedItems = checkedAddonsForCart;
        if (addBtn) {
          addBtn._checkedItems = checkedAddonsForCart;
        }

        // Update price summary display
        if (finalPriceElem) {
          finalPriceElem.textContent = formatMoney(totalDiscountedCents);
        }
        if (originalPriceElem) {
          originalPriceElem.textContent = formatMoney(totalOriginalCents);
          originalPriceElem.style.display = totalOriginalCents > totalDiscountedCents ? 'inline' : 'none';
        }

        if (savingsPill && savingsTextElem) {
          if (checkedCount > 0 && totalOriginalCents > totalDiscountedCents) {
            const savings = totalOriginalCents - totalDiscountedCents;
            savingsTextElem.textContent = `Save ${formatMoney(savings)} (${discountPercentage}% OFF)`;
            savingsPill.style.display = 'inline-flex';
          } else {
            savingsPill.style.display = 'none';
          }
        }

        // Availability check
        if (outOfStockCheckedTitles.length > 0) {
          if (addBtn) {
            addBtn.disabled = true;
            addBtn.classList.add('is-out-of-stock-btn');
          }
          if (btnText) {
            btnText.textContent = 'Out of Stock';
          }
          if (stockAlert && alertText) {
            alertText.textContent = `${outOfStockCheckedTitles.join(', ')} is out of stock. Uncheck to proceed.`;
            stockAlert.style.display = 'flex';
          }
        } else {
          if (addBtn) {
            addBtn.disabled = false;
            addBtn.classList.remove('is-out-of-stock-btn');
          }
          if (stockAlert) {
            stockAlert.style.display = 'none';
          }

          // Dynamic Button text
          let dynamicText = 'Add to Cart with Add-Ons';
          if (checkedCount === 1) {
            dynamicText = 'Add Both to Cart';
          } else if (checkedCount > 1) {
            dynamicText = `Add with ${checkedCount} Add-Ons`;
          } else {
            dynamicText = 'Select an Add-On';
          }

          if (customBtnText && !customBtnText.startsWith('Add with') && !customBtnText.startsWith('Add Both')) {
            dynamicText = customBtnText;
          }

          if (btnText) {
            btnText.textContent = dynamicText;
          }
        }
      }

      // Listeners for checkboxes and variant selects
      items.forEach((item) => {
        const checkbox = item.querySelector('.stackup-addon-checkbox');
        const select = item.querySelector('.stackup-addon-variant-select');
        if (checkbox) checkbox.addEventListener('change', updateAddonsSummary);
        if (select) select.addEventListener('change', updateAddonsSummary);
      });

      // Run calculation immediately on widget discovery
      updateAddonsSummary();

      // Click handler for widget's Add to Cart button
      if (addBtn) {
        addBtn.addEventListener('click', async function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (addBtn.disabled) return;
          await handleAddonsAddToCart(widget, addBtn);
        });
      }
    });
  }

  async function handleAddonsAddToCart(widget, triggerBtn) {
    const rootUrl = window.Shopify?.routes?.root || '/';

    // 1. Gather checked add-on products directly from DOM
    const checkedItems = [];
    const itemRows = widget.querySelectorAll('.stackup-addon-item');
    itemRows.forEach((row) => {
      const checkbox = row.querySelector('.stackup-addon-checkbox');
      if (checkbox && checkbox.checked) {
        const select = row.querySelector('.stackup-addon-variant-select');
        let rawVariantId = select ? select.value : row.dataset.variantId;
        const qty = parseInt(row.dataset.quantity || '1', 10) || 1;
        const title = row.dataset.title || 'Add-on';
        const cleanedId = cleanVariantId(rawVariantId);

        if (cleanedId) {
          checkedItems.push({ id: cleanedId, quantity: qty, title });
        }
      }
    });

    // 2. Determine main product variant ID & quantity from product form
    const mainForm = document.querySelector('form[action*="/cart/add"]');
    const mainVariantInput = mainForm ? mainForm.querySelector('[name="id"]') : null;
    let mainVariantId = mainVariantInput?.value || widget.dataset.mainVariantId;
    mainVariantId = cleanVariantId(mainVariantId);

    const mainQtyInput = mainForm ? mainForm.querySelector('[name="quantity"]') : null;
    const mainQty = parseInt(mainQtyInput?.value || '1', 10) || 1;

    // Guard against Theme Editor preview
    const isSamplePreview = mainVariantId === 'preview' || checkedItems.some((it) => String(it.id).includes('sample'));
    if (isSamplePreview) {
      const stockAlert = widget.querySelector('.stackup-addons-stock-alert');
      const alertText = widget.querySelector('.stackup-addons-alert-text');
      if (stockAlert && alertText) {
        alertText.textContent = 'Theme Editor Preview: Sample add-on products cannot be added to cart. Please test on an active live product.';
        stockAlert.style.display = 'flex';
      }
      return;
    }

    const itemsToAdd = [];
    if (mainVariantId && mainVariantId !== 'preview') {
      itemsToAdd.push({ id: mainVariantId, quantity: mainQty });
    }

    for (const addon of checkedItems) {
      if (addon.id && !String(addon.id).includes('sample')) {
        itemsToAdd.push({ id: addon.id, quantity: addon.quantity || 1 });
      }
    }

    if (itemsToAdd.length === 0) return;

    // UI Loading state
    const btnIcon = widget.querySelector('.stackup-addons-btn-icon');
    const btnText = widget.querySelector('.stackup-addons-btn-text');
    const btnSpinner = widget.querySelector('.stackup-addons-btn-spinner');
    const stockAlert = widget.querySelector('.stackup-addons-stock-alert');
    const alertText = widget.querySelector('.stackup-addons-alert-text');

    if (triggerBtn) triggerBtn.disabled = true;
    if (btnIcon) btnIcon.style.display = 'none';
    if (btnText) btnText.style.display = 'none';
    if (btnSpinner) btnSpinner.style.display = 'inline-flex';
    if (stockAlert) stockAlert.style.display = 'none';

    try {
      const addResponse = await fetch(`${rootUrl}cart/add.js`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          items: itemsToAdd,
        }),
      });

      const responseData = await addResponse.json().catch(() => ({}));

      if (!addResponse.ok) {
        throw new Error(responseData.description || responseData.message || 'One or more items are out of stock.');
      }

      // Notify theme cart listeners
      try {
        document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
        document.dispatchEvent(new CustomEvent('theme:cart:changed', { bubbles: true }));
      } catch (e) { }

      // Direct redirect to checkout so discount applies immediately
      window.location.href = `${rootUrl}checkout`;
    } catch (err) {
      console.error('[StackUp] Add-ons add to cart error:', err);
      if (stockAlert && alertText) {
        alertText.textContent = err.message || 'Could not add items to cart. Please try again.';
        stockAlert.style.display = 'flex';
      }
      if (triggerBtn) triggerBtn.disabled = false;
    } finally {
      if (btnSpinner) btnSpinner.style.display = 'none';
      if (btnIcon) btnIcon.style.display = 'inline-flex';
      if (btnText) btnText.style.display = '';
    }
  }

  function initStackUpBogoWidgets() {
    const widgets = document.querySelectorAll('.stackup-bogo-container');
    if (!widgets || widgets.length === 0) return;
    widgets.forEach((widget) => {
      if (widget.dataset.initialized) return;
      widget.dataset.initialized = 'true';

      const buyVariantSelect = widget.querySelector('#stackup-bogo-buy-variant');
      const getVariantSelect = widget.querySelector('#stackup-bogo-get-variant');
      const addBtn = widget.querySelector('#stackup-bogo-add-btn');

      const dealType = widget.dataset.dealType || 'BOGO';
      const buyQty = parseInt(widget.dataset.buyQty || '1', 10);
      const getQty = parseInt(widget.dataset.getQty || '1', 10);
      const discountType = widget.dataset.discountType || 'P';
      const discountVal = parseFloat(widget.dataset.discountVal || '100');
      const maxDiscount = widget.dataset.maxDiscount ? parseFloat(widget.dataset.maxDiscount) : null;

      function updateTotals() {
        let buyPrice = 0;
        let buyVariantTitle = '';
        let buyVariantId = '';

        if (buyVariantSelect) {
          if (buyVariantSelect.tagName === 'SELECT') {
            const opt = buyVariantSelect.options[buyVariantSelect.selectedIndex];
            buyPrice = parseFloat(opt?.dataset?.price || '0');
            buyVariantTitle = opt?.textContent?.replace(/\(Out of stock\)/i, '').trim() || '';
            buyVariantId = buyVariantSelect.value;
          } else {
            buyPrice = parseFloat(buyVariantSelect.dataset?.price || buyVariantSelect.value || '0');
            buyVariantTitle = buyVariantSelect.dataset?.title || '';
            buyVariantId = buyVariantSelect.value;
          }
        }

        // BOGO & BUY_X_GET_X: Same product reward mirrors Buy product variant
        if (dealType === 'BOGO' || dealType === 'BUY_X_GET_X') {
          if (getVariantSelect && getVariantSelect.tagName === 'INPUT') {
            getVariantSelect.value = buyVariantId;
            getVariantSelect.dataset.price = buyPrice;
          }
          const getVariantTitleEl = widget.querySelector('.stackup-bogo-get-variant-title');
          if (getVariantTitleEl && buyVariantTitle) {
            getVariantTitleEl.textContent = buyVariantTitle;
          }
        }

        let getPrice = 0;
        if (dealType === 'BOGO' || dealType === 'BUY_X_GET_X') {
          getPrice = buyPrice;
        } else if (getVariantSelect) {
          if (getVariantSelect.tagName === 'SELECT') {
            const opt = getVariantSelect.options[getVariantSelect.selectedIndex];
            getPrice = parseFloat(opt?.dataset?.price || '0');
          } else {
            getPrice = parseFloat(getVariantSelect.dataset?.price || getVariantSelect.value || '0');
          }
        }

        const buyTotal = buyPrice * buyQty;
        const getOriginalTotal = getPrice * getQty;

        let rawDiscount = 0;
        if (discountType === 'F') {
          rawDiscount = discountVal * 100 * getQty;
        } else {
          rawDiscount = getOriginalTotal * (discountVal / 100);
        }

        let discountAmount = Math.min(getOriginalTotal, rawDiscount);
        if (maxDiscount && maxDiscount > 0) {
          discountAmount = Math.min(discountAmount, maxDiscount * 100);
        }

        const discountedGetTotal = Math.max(0, getOriginalTotal - discountAmount);
        const originalGrandTotal = buyTotal + getOriginalTotal;
        const finalGrandTotal = buyTotal + discountedGetTotal;

        const buySubtotalEl = widget.querySelector('.stackup-bogo-buy-subtotal');
        const buyUnitEl = widget.querySelector('.stackup-bogo-buy-unit');
        if (buySubtotalEl) buySubtotalEl.textContent = formatMoney(buyTotal);
        if (buyUnitEl) buyUnitEl.textContent = formatMoney(buyPrice) + ' per item';

        const getSubtotalEl = widget.querySelector('.stackup-bogo-get-subtotal');
        const getOriginalEl = widget.querySelector('.stackup-bogo-get-original');
        const getUnitEl = widget.querySelector('.stackup-bogo-get-unit');

        if (getSubtotalEl) getSubtotalEl.textContent = formatMoney(discountedGetTotal);
        if (getOriginalEl) getOriginalEl.textContent = formatMoney(getOriginalTotal);
        if (getUnitEl)
          getUnitEl.textContent = formatMoney(getQty > 0 ? discountedGetTotal / getQty : 0) + ' per item';

        const discountValEl = widget.querySelector('.stackup-bogo-discount-val');
        if (discountValEl) discountValEl.textContent = '-' + formatMoney(discountAmount);

        const grandOrigEl = widget.querySelector('.stackup-bogo-grand-original');
        const grandFinalEl = widget.querySelector('.stackup-bogo-grand-final');
        if (grandOrigEl) grandOrigEl.textContent = formatMoney(originalGrandTotal);
        if (grandFinalEl) grandFinalEl.textContent = formatMoney(finalGrandTotal);
      }

      if (buyVariantSelect && buyVariantSelect.tagName === 'SELECT') {
        buyVariantSelect.addEventListener('change', updateTotals);
      }
      if (getVariantSelect && getVariantSelect.tagName === 'SELECT') {
        getVariantSelect.addEventListener('change', updateTotals);
      }

      updateTotals();

      if (addBtn) {
        addBtn.addEventListener('click', function (e) {
          e.preventDefault();

          const rawBuyId = buyVariantSelect ? buyVariantSelect.value : null;
          const rawGetId = getVariantSelect ? getVariantSelect.value : null;

          let buyVariantId = cleanVariantId(rawBuyId);
          let getVariantId = cleanVariantId(rawGetId);

          if (dealType === 'BOGO' || dealType === 'BUY_X_GET_X') {
            getVariantId = buyVariantId;
          }

          if (!buyVariantId || !getVariantId) {
            alert('Please select the product variant.');
            return;
          }

          const iconEl = addBtn.querySelector('.stackup-bogo-btn-icon');
          const labelEl = addBtn.querySelector('.stackup-bogo-btn-label');
          const spinnerEl = addBtn.querySelector('.stackup-bogo-btn-spinner');

          addBtn.disabled = true;
          addBtn.style.opacity = '0.75';
          addBtn.style.cursor = 'not-allowed';
          if (iconEl) iconEl.style.display = 'none';
          if (labelEl) labelEl.style.display = 'none';
          if (spinnerEl) spinnerEl.style.display = 'inline-flex';

          let items = [];
          if (dealType === 'BOGO' || dealType === 'BUY_X_GET_X' || buyVariantId === getVariantId) {
            items.push({
              id: parseInt(buyVariantId, 10),
              quantity: buyQty + getQty,
            });
          } else {
            items.push({
              id: parseInt(buyVariantId, 10),
              quantity: buyQty,
            });
            items.push({
              id: parseInt(getVariantId, 10),
              quantity: getQty,
            });
          }

          const rootUrl = window.Shopify?.routes?.root || '/';

          fetch(`${rootUrl}cart/add.js`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ items: items }),
          })
            .then((res) => {
              if (!res.ok) {
                return res.json().then((errData) => {
                  throw new Error(errData.description || errData.message || 'Error adding to cart.');
                });
              }
              return res.json();
            })
            .then((data) => {
              document.dispatchEvent(new CustomEvent('cart:updated', { bubbles: true }));
              document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));

              // Keep loader running while navigating directly to checkout
              window.location.href = `${rootUrl}checkout`;
            })
            .catch((err) => {
              console.error('[StackUp:BOGO] Add to cart error:', err);
              alert(err.message || 'Could not add to cart. Please try again.');
              addBtn.disabled = false;
              addBtn.style.opacity = '1';
              addBtn.style.cursor = 'pointer';
              if (iconEl) iconEl.style.display = 'inline-flex';
              if (labelEl) labelEl.style.display = 'inline';
              if (spinnerEl) spinnerEl.style.display = 'none';
            });
        });
      }
    });
  }

  function initStackUpVolumeWidgets() {
    const widgets = document.querySelectorAll('.stackup-volume-widget');
    if (!widgets || widgets.length === 0) return;

    widgets.forEach((widget) => {
      if (widget.dataset.initialized) return;
      widget.dataset.initialized = 'true';

      const cards = widget.querySelectorAll('.stackup-volume-tier-card');
      const atcBtn = widget.querySelector('.stackup-volume-atc-btn');
      const atcText = widget.querySelector('.stackup-atc-text');
      const btnIcon = widget.querySelector('.stackup-btn-icon');
      const btnSpinner = widget.querySelector('.stackup-btn-spinner');
      const stockAlert = widget.querySelector('.stackup-volume-stock-alert');
      const alertText = widget.querySelector('.stackup-volume-alert-text');
      const savingsBanner = widget.querySelector('.stackup-volume-savings-banner');
      const savingsAmount = widget.querySelector('.stackup-volume-savings-amount');
      const savingsPct = widget.querySelector('.stackup-volume-savings-pct');
      const btnTemplate = widget.getAttribute('data-btn-template') || 'Add {quantity} to Cart';
      const activeBorder = widget.getAttribute('data-active-border') || '#111827';
      const activeWidth = widget.getAttribute('data-active-border-width') || '2';
      const normalBorder = widget.getAttribute('data-normal-border') || '#e5e7eb';

      let activeCard =
        widget.querySelector(".stackup-volume-tier-card[data-is-default='true']") ||
        widget.querySelector('.stackup-volume-tier-card.active') ||
        cards[0];

      function updateUI() {
        if (!activeCard) return;

        cards.forEach((c) => {
          const isSel = c === activeCard;
          c.style.setProperty(
            'border',
            isSel ? activeWidth + 'px solid ' + activeBorder : activeWidth + 'px solid ' + normalBorder,
            'important'
          );
          const radio = c.querySelector('.stackup-tier-radio');
          if (radio) {
            radio.style.setProperty('border', isSel ? '6px solid ' + activeBorder : '2px solid #9ca3af', 'important');
            radio.style.setProperty('display', 'flex', 'important');
            radio.style.setProperty('width', '20px', 'important');
            radio.style.setProperty('height', '20px', 'important');
            radio.style.setProperty('min-width', '20px', 'important');
            radio.style.setProperty('min-height', '20px', 'important');
            radio.style.setProperty('border-radius', '50%', 'important');
            radio.style.setProperty('background', '#ffffff', 'important');
            radio.style.setProperty('box-sizing', 'border-box', 'important');
            radio.style.setProperty('flex-shrink', '0', 'important');
          }
        });

        const qty = activeCard.getAttribute('data-qty') || '1';
        const priceSpan = activeCard.querySelector('.stackup-tier-price');
        const formattedPrice = priceSpan ? priceSpan.textContent.trim() : '';

        if (atcText) {
          const baseTxt = btnTemplate.replace(/\{quantity\}/gi, qty);
          atcText.textContent = formattedPrice ? `${baseTxt} • ${formattedPrice}` : baseTxt;
        }

        if (savingsBanner) {
          const discountVal = parseFloat(activeCard.getAttribute('data-discount') || '0');
          const origPrice = parseFloat(activeCard.getAttribute('data-orig-price') || '0');
          const totalPrice = parseFloat(activeCard.getAttribute('data-total-price') || '0');
          const savedCents = Math.max(0, origPrice - totalPrice);

          if (savedCents > 0 && discountVal > 0) {
            const currencyPrefix = (formattedPrice.match(/^[^0-9]+/) || ['$'])[0];
            const savedFmt = currencyPrefix + (savedCents / 100).toFixed(2);
            if (savingsAmount) savingsAmount.textContent = savedFmt;
            if (savingsPct) savingsPct.textContent = `(${Math.round(discountVal)}% OFF)`;
            savingsBanner.style.setProperty('display', 'flex', 'important');
          } else {
            savingsBanner.style.setProperty('display', 'none', 'important');
          }
        }

        const formQtyInput = document.querySelector('form[action*="/cart/add"] input[name="quantity"]');
        if (formQtyInput) {
          formQtyInput.value = qty;
          formQtyInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      cards.forEach((card) => {
        card.addEventListener('click', () => {
          activeCard = card;
          updateUI();
        });
      });

      if (atcBtn) {
        atcBtn.addEventListener('click', async () => {
          const qty = parseInt(activeCard?.getAttribute('data-qty') || '1', 10);
          const variantIdInput =
            document.querySelector('form[action*="/cart/add"] [name="id"]') ||
            document.querySelector('select[name="id"], input[name="id"]');
          const variantId = variantIdInput ? variantIdInput.value : widget.getAttribute('data-default-variant-id');

          if (!variantId) return;

          atcBtn.disabled = true;
          atcBtn.style.opacity = '0.75';
          atcBtn.style.cursor = 'not-allowed';
          if (btnIcon) btnIcon.style.display = 'none';
          if (atcText) atcText.style.display = 'none';
          if (btnSpinner) btnSpinner.style.display = 'inline-flex';
          if (stockAlert) stockAlert.style.display = 'none';

          try {
            const rootUrl = window.Shopify?.routes?.root || '/';
            const res = await fetch(`${rootUrl}cart/add.js`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({
                items: [{ id: parseInt(variantId, 10), quantity: qty }],
              }),
            });

            const responseData = await res.json().catch(() => ({}));

            if (!res.ok) {
              throw new Error(
                responseData.description || responseData.message || 'This product is out of stock, not available.'
              );
            }

            document.dispatchEvent(new CustomEvent('cart:updated', { bubbles: true }));
            document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));

            window.location.href = `${rootUrl}checkout`;
          } catch (e) {
            console.error('[StackUp Volume] Error adding to cart:', e);
            if (stockAlert && alertText) {
              alertText.textContent = e.message || 'Could not add items to cart. Please try again.';
              stockAlert.style.display = 'flex';
            }
            if (btnSpinner) btnSpinner.style.display = 'none';
            if (btnIcon) btnIcon.style.display = 'inline-flex';
            if (atcText) atcText.style.display = '';
            atcBtn.style.opacity = '1';
            atcBtn.style.cursor = 'pointer';
            atcBtn.disabled = false;
          }
        });
      }

      updateUI();
    });
  }

  function checkIsAppEnabled() {
    return !!(
      document.querySelector('[data-stackup-embed-active]') ||
      window.StackUpAppEmbedActive === true ||
      document.documentElement.classList.contains('stackup-active') ||
      (document.body && document.body.classList.contains('stackup-active'))
    );
  }

  function initStackUpWidgets() {
    const isEmbedActive = checkIsAppEnabled();
    const widgets = document.querySelectorAll(
      '.stackup-paired-widget, .stackup-addons-widget, .stackup-volume-widget, .stackup-bogo-container, .stackup-cart-goal-wrapper'
    );

    if (!isEmbedActive) {
      widgets.forEach((w) => {
        w.classList.remove('stackup-visible');
        w.style.setProperty('display', 'none', 'important');
      });
      return;
    }

    widgets.forEach((w) => {
      w.classList.add('stackup-visible');
      w.style.removeProperty('display');
    });

    try {
      initStackUpPairedWidgets();
    } catch (e) {
      console.warn('[StackUp] Paired widgets init warning:', e);
    }
    try {
      initStackUpAddonsWidgets();
    } catch (e) {
      console.warn('[StackUp] Add-ons widget init warning:', e);
    }
    try {
      initStackUpBogoWidgets();
    } catch (e) {
      console.warn('[StackUp] BOGO widget init warning:', e);
    }
    try {
      initStackUpVolumeWidgets();
    } catch (e) {
      console.warn('[StackUp] Volume widget init warning:', e);
    }
    try {
      initStackUpCartGoal();
    } catch (e) {
      console.warn('[StackUp] Cart Goal widget init warning:', e);
    }
  }

  // Safe alias to prevent ReferenceError
  function initStackUpSelectedWidgets() {
    return initStackUpAddonsWidgets();
  }

  function resetAllStackUpButtons() {
    // Reset BOGO buttons
    document.querySelectorAll('#stackup-bogo-add-btn').forEach((btn) => {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      const iconEl = btn.querySelector('.stackup-bogo-btn-icon');
      const labelEl = btn.querySelector('.stackup-bogo-btn-label');
      const spinnerEl = btn.querySelector('.stackup-bogo-btn-spinner');
      if (iconEl) iconEl.style.display = 'inline-flex';
      if (labelEl) labelEl.style.display = 'inline';
      if (spinnerEl) spinnerEl.style.display = 'none';
    });

    // Reset Volume buttons
    document.querySelectorAll('.stackup-volume-atc-btn').forEach((btn) => {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      const iconEl = btn.querySelector('.stackup-btn-icon');
      const atcText = btn.querySelector('.stackup-atc-text');
      const spinnerEl = btn.querySelector('.stackup-btn-spinner');
      if (iconEl) iconEl.style.display = 'inline-flex';
      if (atcText) atcText.style.display = '';
      if (spinnerEl) spinnerEl.style.display = 'none';
    });

    // Reset Paired bundles buttons
    document.querySelectorAll('.stackup-add-button').forEach((btn) => {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      const btnText = btn.querySelector('.stackup-btn-text');
      const btnIcon = btn.querySelector('.stackup-btn-icon');
      const btnSpinner = btn.querySelector('.stackup-btn-spinner');
      if (btnText) btnText.style.display = '';
      if (btnIcon) btnIcon.style.display = 'inline-flex';
      if (btnSpinner) btnSpinner.style.display = 'none';
    });

    // Reset Addons buttons
    document.querySelectorAll('.stackup-addons-btn').forEach((btn) => {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      const btnText = btn.querySelector('.stackup-btn-text');
      const btnIcon = btn.querySelector('.stackup-btn-icon');
      const btnSpinner = btn.querySelector('.stackup-btn-spinner');
      if (btnText) btnText.style.display = '';
      if (btnIcon) btnIcon.style.display = 'inline-flex';
      if (btnSpinner) btnSpinner.style.display = 'none';
    });
  }

  // ==========================================================================
  // STACKUP CART GOAL & TIERED CART-VALUE PROGRESS BAR ENGINE
  // Multi-Theme Drawer Auto-Detect + Real-Time Ajax Cart State Machine
  // ==========================================================================

  let isCartGoalUpdating = false;
  let cartGoalSyncTimeout = null;

  function getCartGoalWidgetSettings() {
    const el = document.getElementById('stackup-cart-goal-widget-settings');
    if (el) {
      try {
        let text = (el.textContent || '').trim();
        if (text) {
          let parsed = JSON.parse(text);
          while (typeof parsed === 'string') parsed = JSON.parse(parsed);
          if (parsed && typeof parsed === 'object') return parsed;
        }
      } catch (e) {
        console.warn('[StackUp:CartGoal] Error parsing widget settings:', e);
      }
    }
    return null;
  }

  function getCartGoalOffers() {
    const configElems = document.querySelectorAll('#stackup-cart-goal-config, script[data-stackup-cart-goal]');
    for (const configElem of configElems) {
      try {
        const text = (configElem.textContent || '').trim();
        if (!text) continue;
        let data = JSON.parse(text);
        while (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch {
            break;
          }
        }
        if (Array.isArray(data) && data.length > 0) return data;
        if (data && typeof data === 'object' && Array.isArray(data.tiers)) return [data];
      } catch (err) {
        console.warn('[StackUp:CartGoal] Error parsing config:', err);
      }
    }

    if (window._stackupCartGoalOffers && Array.isArray(window._stackupCartGoalOffers)) {
      return window._stackupCartGoalOffers;
    }

    // Fallback in Shopify Theme Editor (design_mode) to ensure immediate visual rendering
    const isEditor = Boolean(
      (window.Shopify && window.Shopify.designMode) ||
      document.querySelector('[data-shopify-editor]') ||
      document.body?.classList?.contains('shopify-design-mode') ||
      window.location.search?.includes('design_mode')
    );
    if (isEditor) {
      return [
        {
          id: 'editor-preview-goal',
          title: 'Spend More, Save More',
          widgetTitle: '',
          status: 'ACTIVE',
          tiers: [
            { minAmount: 100, discountType: 'PERCENTAGE', discountValue: 10, label: '10% off', hasFreeShipping: false },
            { minAmount: 200, discountType: 'PERCENTAGE', discountValue: 15, label: '15% off', hasFreeShipping: true }
          ],
          widget: {
            heading: '{widgettitle}',
            initialMessage: 'Add {{remaining}} more to unlock {{next_tier}}!',
            progressMessage: '🎉 {{current_tier}} unlocked! Add {{remaining}} for {{next_tier}}!',
            completedMessage: '🎉 Congratulations! You unlocked {{reward}}!',
            barColor: '#000000',
            trackColor: '#e5e7eb',
            achievedColor: '#10b981',
            cardSurface: '#ffffff',
            borderColor: '#e5e7eb',
            borderRadius: 12,
            barHeight: 8,
            textColor: '#111827',
            milestoneTextColor: '#6b7280'
          }
        }
      ];
    }

    return null;
  }

  const CART_DRAWER_SELECTORS = [
    'cart-drawer .drawer__inner',
    'cart-drawer .cart-drawer__content',
    'cart-drawer .cart-drawer__body',
    'cart-drawer [class*="inner"]',
    'cart-drawer',
    '#CartDrawer .drawer__inner',
    '#CartDrawer',
    '.drawer__inner',
    '.cart-drawer__content',
    '.cart-drawer__body',
    '.mini-cart__content',
    '.slideout-cart__content',
    '[data-cart-drawer]',
    '.drawer--is-open',
    '.js-drawer.is-open',
  ];

  function isCartPage() {
    const p = (window.location.pathname || '').toLowerCase();
    return p === '/cart' || p.endsWith('/cart') || p.includes('/cart');
  }

  function createCartGoalMarkup(offer, elementId) {
    const wrapper = document.createElement('div');
    wrapper.className = 'stackup-cart-goal-wrapper';
    wrapper.id = elementId || 'stackup-cart-goal-bar';

    const card = document.createElement('div');
    card.className = 'stackup-cart-goal-card';

    // Apply custom styling variables from cart_goal_widget_settings (or fallback to offer.widget)
    const customSettings = getCartGoalWidgetSettings();
    const w = customSettings?.styles || offer?.widget || {};
    if (w) {
      if (w.cardSurface) card.style.setProperty('--stackup-goal-card-bg', w.cardSurface);
      if (w.borderColor) card.style.setProperty('--stackup-goal-border-color', w.borderColor);
      if (w.borderRadius !== undefined) card.style.setProperty('--stackup-goal-card-radius', `${w.borderRadius}px`);
      if (w.barColor) card.style.setProperty('--stackup-goal-fill-color', w.barColor);
      if (w.trackColor) card.style.setProperty('--stackup-goal-track-color', w.trackColor);
      if (w.achievedColor) card.style.setProperty('--stackup-goal-completed-color', w.achievedColor);
      if (w.textColor) card.style.setProperty('--stackup-goal-text-color', w.textColor);
    }

    // Optional widget headline if defined
    if (offer && offer.widgetTitle && offer.widgetTitle.trim()) {
      const headline = document.createElement('div');
      headline.className = 'stackup-cart-goal-headline';
      headline.textContent = offer.widgetTitle;
      card.appendChild(headline);
    }

    // Unified motivational message container (no detached icon span)
    const header = document.createElement('div');
    header.className = 'stackup-cart-goal-header';
    header.innerHTML = '<div class="stackup-cart-goal-title">Add items to unlock discount rewards!</div>';

    const trackContainer = document.createElement('div');
    trackContainer.className = 'stackup-cart-goal-track-container';
    trackContainer.innerHTML = '<div class="stackup-cart-goal-track"><div class="stackup-cart-goal-fill" style="width: 0%;"></div></div><div class="stackup-cart-goal-markers"></div>';

    card.appendChild(header);
    card.appendChild(trackContainer);
    wrapper.appendChild(card);
    return wrapper;
  }

  function ensureCartGoalInDrawer(offer) {
    // Never auto-inject drawer widget on full /cart page (user added the Cart Goal Progress Bar theme block)
    if (isCartPage()) return null;

    let widget = document.getElementById('stackup-cart-goal-bar-drawer');
    if (widget) return widget;

    let drawer = null;
    for (const sel of CART_DRAWER_SELECTORS) {
      try {
        const elem = document.querySelector(sel);
        if (elem) {
          drawer = elem;
          break;
        }
      } catch { }
    }

    if (!drawer) return null;

    // Check if drawer already contains a cart goal wrapper
    const existingInDrawer = drawer.querySelector('.stackup-cart-goal-wrapper');
    if (existingInDrawer) {
      return existingInDrawer;
    }

    widget = createCartGoalMarkup(offer, 'stackup-cart-goal-bar-drawer');
    widget.classList.add('stackup-cart-goal-in-drawer');

    const drawerHeader = drawer.querySelector('.drawer__header, .cart-drawer__header, [class*="header"]');
    const drawerItems = drawer.querySelector('cart-drawer-items, .cart__items, .cart-items, form[action^="/cart"], .drawer__contents');

    if (drawerHeader && drawerHeader.parentNode && drawerHeader.nextSibling) {
      drawerHeader.parentNode.insertBefore(widget, drawerHeader.nextSibling);
    } else if (drawerItems && drawerItems.parentNode) {
      drawerItems.parentNode.insertBefore(widget, drawerItems);
    } else if (drawer.firstChild) {
      drawer.insertBefore(widget, drawer.firstChild);
    } else {
      drawer.appendChild(widget);
    }

    return widget;
  }

  function ensureAllCartGoalWidgetsInDOM(offer) {
    // 1. Immediately remove any previously auto-appended page widget to prevent duplicate progress bars
    const oldPageWidget = document.getElementById('stackup-cart-goal-bar-page');
    if (oldPageWidget) {
      oldPageWidget.remove();
    }

    const widgets = [];

    // 2. Discover all static Liquid theme block widgets added via Theme Editor ("Cart Goal Progress Bar")
    document.querySelectorAll('.stackup-cart-goal-wrapper').forEach((w) => {
      if (w.id !== 'stackup-cart-goal-bar-page' && !widgets.includes(w)) {
        widgets.push(w);
      }
    });

    // 3. For slide-out drawer on non-cart pages only (if no block is already present)
    if (!isCartPage()) {
      const drawerWidget = ensureCartGoalInDrawer(offer);
      if (drawerWidget && !widgets.includes(drawerWidget)) {
        widgets.push(drawerWidget);
      }
    }

    return widgets;
  }

  async function updateCartGoalUI() {
    if (isCartGoalUpdating) return;

    const offers = getCartGoalOffers();
    if (!offers || offers.length === 0) return;

    const offer = offers[0];
    const tiers = Array.isArray(offer.tiers) ? offer.tiers : [];
    if (tiers.length === 0) return;

    const widgets = ensureAllCartGoalWidgetsInDOM(offer);
    if (!widgets || widgets.length === 0) return;

    try {
      const rootUrl = window.Shopify?.routes?.root || '/';
      let cart = null;
      try {
        const res = await fetch(`${rootUrl}cart.js`, { credentials: 'same-origin' });
        if (res.ok) {
          cart = await res.json();
        }
      } catch (fetchErr) {
        console.warn('[StackUp:CartGoal] cart.js fetch notice:', fetchErr);
      }

      // Compute subtotal in dollars (excluding free gift items)
      const isSpecificProducts = offer.applyTo === 'PRODUCTS' && Array.isArray(offer.products) && offer.products.length > 0;
      const isSpecificCollections = offer.applyTo === 'COLLECTIONS' && (
        (Array.isArray(offer.collectionProductIds) && offer.collectionProductIds.length > 0) ||
        (Array.isArray(offer.collections) && offer.collections.length > 0)
      );
      const isFiltered = isSpecificProducts || isSpecificCollections;

      // Build Set of eligible product IDs
      const eligibleProdIds = new Set();
      if (isSpecificProducts) {
        offer.products.forEach(p => {
          const pid = String(p.id || p).split('/').pop();
          if (pid) eligibleProdIds.add(pid);
        });
      }
      if (isSpecificCollections && Array.isArray(offer.collectionProductIds)) {
        offer.collectionProductIds.forEach(pid => {
          const idStr = String(pid).split('/').pop();
          if (idStr) eligibleProdIds.add(idStr);
        });
      }

      // Read Liquid collections map if available
      let liquidCollectionMap = {};
      try {
        const mapEl = document.getElementById('stackup-cart-collection-map');
        if (mapEl) liquidCollectionMap = JSON.parse(mapEl.textContent || '{}');
      } catch {}

      const targetColIds = new Set((offer.collections || []).map(c => String(c.id || c).split('/').pop()));
      const targetColHandles = new Set((offer.collections || []).map(c => String(c.handle || '').toLowerCase()).filter(Boolean));

      // Multi-Currency & Exchange Rate Detection
      const sampleWidget = document.querySelector('.stackup-cart-goal-wrapper');
      const cartCurrencyCode = (
        cart?.currency ||
        sampleWidget?.dataset?.cartCurrencyCode ||
        window.Shopify?.currency?.active ||
        sampleWidget?.dataset?.shopCurrency ||
        ''
      ).toUpperCase();
      const rawRate = window.Shopify && window.Shopify.currency && parseFloat(window.Shopify.currency.rate);
      const currencyRate = (!rawRate || isNaN(rawRate) || rawRate <= 0) ? 1.0 : rawRate;

      // Dynamic currency subunit divisor (e.g., 100 for USD/EUR/INR, 1 for JPY/KRW, 1000 for KWD)
      function getSubunitDivisor(currencyCode) {
        if (!currencyCode) return 100;
        try {
          const digits = new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: currencyCode,
          }).resolvedOptions().maximumFractionDigits;
          return typeof digits === 'number' ? Math.pow(10, digits) : 100;
        } catch {
          return 100;
        }
      }
      const subunitDivisor = getSubunitDivisor(cartCurrencyCode);

      function formatCartGoalMoney(amount, currency) {
        const cur = (currency || cartCurrencyCode || sampleWidget?.dataset?.shopCurrency || '').toUpperCase();
        try {
          if (cur) {
            return new Intl.NumberFormat(undefined, {
              style: 'currency',
              currency: cur,
            }).format(amount);
          }
        } catch {}
        const sym = sampleWidget?.dataset?.cartCurrencySymbol;
        if (sym) {
          return `${sym}${Number(amount || 0).toFixed(2)}`;
        }
        return `${Number(amount || 0).toFixed(2)}${cur ? ` ${cur}` : ''}`;
      }

      let totalCartItemsCount = 0;
      let totalPaidSubtotalDollars = 0;
      let eligibleSubtotalDollars = 0;
      let freeGiftInCart = null;

      if (cart && Array.isArray(cart.items)) {
        for (const item of cart.items) {
          const isGift = item.properties && (item.properties._stackup_free_gift === 'true' || item.properties._stackup_free_gift === true);
          if (isGift) {
            freeGiftInCart = item;
          } else {
            // Use pre-discount original price so applying the unlocked tier discount does not reduce progress
            const linePrice = (item.original_line_price || item.final_line_price || item.line_price || 0) / subunitDivisor;
            totalPaidSubtotalDollars += linePrice;
            totalCartItemsCount += (item.quantity || 1);

            let itemEligible = true;
            const prodNum = String(item.product_id || '').split('/').pop();

            if (isSpecificProducts) {
              itemEligible = eligibleProdIds.has(prodNum);
            } else if (isSpecificCollections) {
              if (eligibleProdIds.has(prodNum)) {
                itemEligible = true;
              } else {
                const itemCols = liquidCollectionMap[prodNum] || [];
                itemEligible = itemCols.some(col => targetColIds.has(String(col).split('/').pop()) || targetColHandles.has(String(col).toLowerCase()));
              }
            }

            if (itemEligible) {
              eligibleSubtotalDollars += linePrice;
            }
          }
        }
      } else {
        // Fallback: Read subtotal from cart block data attribute
        const subtotalWidget = document.querySelector('.stackup-cart-goal-wrapper[data-cart-subtotal]');
        if (subtotalWidget && subtotalWidget.dataset.cartSubtotal) {
          totalPaidSubtotalDollars = (parseFloat(subtotalWidget.dataset.cartSubtotal) || 0) / subunitDivisor;
          eligibleSubtotalDollars = totalPaidSubtotalDollars;
          totalCartItemsCount = 1;
        } else {
          // If in Theme Editor with zero cart, show sample progress
          const isDesignMode = Boolean((window.Shopify && window.Shopify.designMode) || document.querySelector('[data-shopify-editor]'));
          if (isDesignMode) {
            totalPaidSubtotalDollars = 50 * currencyRate;
            eligibleSubtotalDollars = 50 * currencyRate;
            totalCartItemsCount = 1;
          }
        }
      }

      const progressSubtotal = isFiltered ? eligibleSubtotalDollars : totalPaidSubtotalDollars;

      // Sort tiers ascending and convert thresholds to customer's active currency
      const sortedTiers = [...tiers].sort((a, b) => (Number(a.minAmount) || 0) - (Number(b.minAmount) || 0));
      const maxTierAmount = Math.max(1, (Number(sortedTiers[sortedTiers.length - 1].minAmount) || 100) * currencyRate);

      // Determine All Achieved Tiers (Cumulative, converted by currencyRate)
      const achievedTiers = sortedTiers.filter(t => progressSubtotal >= ((Number(t.minAmount) || 0) * currencyRate));
      const activeDiscountTier = achievedTiers.slice().reverse().find(t => parseFloat(t.discountValue) > 0);
      const hasFreeShippingUnlocked = achievedTiers.some(t => Boolean(t.hasFreeShipping));
      const activeGiftTier = achievedTiers.slice().reverse().find(t => t.freeGift && (t.freeGift.variantId || t.freeGift.productId || t.freeGift.id));

      let currentTier = achievedTiers.length > 0 ? achievedTiers[achievedTiers.length - 1] : null;
      let nextTier = sortedTiers.find(t => progressSubtotal < ((Number(t.minAmount) || 0) * currencyRate)) || null;

      // Calculate progress percentage
      let progressPercent = 0;
      if (progressSubtotal >= maxTierAmount) {
        progressPercent = 100;
      } else {
        progressPercent = Math.min(100, Math.max(0, (progressSubtotal / maxTierAmount) * 100));
      }

      // Helper to compute cumulative unlocked reward labels
      function formatCumulativeRewards(achieved) {
        if (!achieved || achieved.length === 0) return 'maximum savings';
        const parts = [];
        const discTier = achieved.slice().reverse().find(t => parseFloat(t.discountValue) > 0);
        if (discTier) {
          const val = parseFloat(discTier.discountValue);
          const isFixed = String(discTier.discountType).toUpperCase() === 'FIXED_AMOUNT';
          const displayVal = isFixed ? formatCartGoalMoney(val * currencyRate, cartCurrencyCode) : `${val}%`;
          parts.push(isFixed ? `${displayVal} off` : `${val}% off`);
        }
        if (achieved.some(t => Boolean(t.hasFreeShipping))) {
          parts.push('Free Shipping');
        }
        const giftTier = achieved.slice().reverse().find(t => t.freeGift && (t.freeGift.title || t.freeGift.variantId));
        if (giftTier) {
          parts.push(`Free ${giftTier.freeGift.title || 'Gift'}`);
        }
        return parts.length > 0 ? parts.join(' + ') : 'maximum savings';
      }

      function formatTierNewReward(tier) {
        if (!tier) return 'next reward';
        const parts = [];
        const val = parseFloat(tier.discountValue) || 0;
        if (val > 0) {
          const isFixed = String(tier.discountType).toUpperCase() === 'FIXED_AMOUNT';
          const displayVal = isFixed ? formatCartGoalMoney(val * currencyRate, cartCurrencyCode) : `${val}%`;
          parts.push(isFixed ? `${displayVal} off` : `${val}% off`);
        }
        if (tier.hasFreeShipping) {
          parts.push('Free Shipping');
        }
        if (tier.freeGift && (tier.freeGift.title || tier.freeGift.variantId)) {
          parts.push(`Free ${tier.freeGift.title || 'Gift'}`);
        }
        return parts.length > 0 ? parts.join(' + ') : (tier.label || 'next tier');
      }

      let motivationalHtml = '';
      if (progressPercent >= 100) {
        const unlockedRewardText = formatCumulativeRewards(achievedTiers.length > 0 ? achievedTiers : sortedTiers);
        motivationalHtml = `<span class="stackup-goal-unlocked-text">🎉 Congratulations!</span> <span class="stackup-goal-next-text">You unlocked <strong>${unlockedRewardText}</strong>!</span>`;
      } else if (achievedTiers.length > 0 && nextTier) {
        const nextThreshold = (Number(nextTier.minAmount) || 0) * currencyRate;
        const remaining = Math.max(0, nextThreshold - progressSubtotal);
        const remainingStr = formatCartGoalMoney(remaining, cartCurrencyCode);
        const currentRewardText = formatCumulativeRewards(achievedTiers);
        const nextRewardText = formatTierNewReward(nextTier);
        motivationalHtml = `<span class="stackup-goal-unlocked-text">🎉 ${currentRewardText} unlocked!</span> <span class="stackup-goal-next-text">Add <strong>${remainingStr}</strong> for <strong>${nextRewardText}</strong>!</span>`;
      } else if (nextTier) {
        const nextThreshold = (Number(nextTier.minAmount) || 0) * currencyRate;
        const remaining = Math.max(0, nextThreshold - progressSubtotal);
        const remainingStr = formatCartGoalMoney(remaining, cartCurrencyCode);
        const nextRewardText = formatTierNewReward(nextTier);
        motivationalHtml = `<span class="stackup-goal-next-text">Add <strong>${remainingStr}</strong> more to unlock <strong>${nextRewardText}</strong>!</span>`;
      }

      // Update all active instances (Page and/or Drawer)
      const customSettings = getCartGoalWidgetSettings();
      const wStyles = customSettings?.styles || offer?.widget || {};

      widgets.forEach((widget) => {
        // Always show the progress bar whenever items are in the cart
        if (totalCartItemsCount > 0) {
          widget.style.display = '';
        }
        // Apply card styling from cart_goal_widget_settings
        const card = widget.querySelector('.stackup-cart-goal-card');
        if (card && wStyles) {
          if (wStyles.cardSurface) card.style.setProperty('--stackup-goal-card-bg', wStyles.cardSurface);
          if (wStyles.borderColor) card.style.setProperty('--stackup-goal-border-color', wStyles.borderColor);
          if (wStyles.borderRadius !== undefined) card.style.setProperty('--stackup-goal-card-radius', `${wStyles.borderRadius}px`);
          if (wStyles.barColor) card.style.setProperty('--stackup-goal-fill-color', wStyles.barColor);
          if (wStyles.trackColor) card.style.setProperty('--stackup-goal-track-color', wStyles.trackColor);
          if (wStyles.achievedColor) card.style.setProperty('--stackup-goal-completed-color', wStyles.achievedColor);
          if (wStyles.textColor) card.style.setProperty('--stackup-goal-text-color', wStyles.textColor);
        }

        // Headline
        if (offer && offer.widgetTitle && offer.widgetTitle.trim()) {
          let headline = widget.querySelector('.stackup-cart-goal-headline');
          if (!headline && card) {
            headline = document.createElement('div');
            headline.className = 'stackup-cart-goal-headline';
            card.insertBefore(headline, card.firstChild);
          }
          if (headline) headline.textContent = offer.widgetTitle;
        }

        // Scope Badge: Informs customers when progress applies only to specific collections or products
        let scopeBadgeText = '';
        if (isSpecificCollections && Array.isArray(offer.collections) && offer.collections.length > 0) {
          const colTitles = offer.collections.map(c => c.title || 'Collection').join(', ');
          scopeBadgeText = `🏷️ Valid on: <strong>${colTitles}</strong> collection only`;
        } else if (isSpecificProducts && Array.isArray(offer.products) && offer.products.length > 0) {
          if (offer.products.length === 1) {
            scopeBadgeText = `🏷️ Valid on: <strong>${offer.products[0].title || 'Product'}</strong> only`;
          } else {
            scopeBadgeText = `🏷️ Valid on selected <strong>${offer.products.length} products</strong> only`;
          }
        }

        let badgeRow = card ? card.querySelector('.stackup-cart-goal-badge-row') : null;
        if (scopeBadgeText) {
          if (!badgeRow && card) {
            badgeRow = document.createElement('div');
            badgeRow.className = 'stackup-cart-goal-badge-row';
            const badgeEl = document.createElement('div');
            badgeEl.className = 'stackup-cart-goal-scope-badge';
            badgeRow.appendChild(badgeEl);

            const header = card.querySelector('.stackup-cart-goal-header');
            if (header) {
              card.insertBefore(badgeRow, header);
            } else {
              card.appendChild(badgeRow);
            }
          }
          const badgeEl = badgeRow ? badgeRow.querySelector('.stackup-cart-goal-scope-badge') : null;
          if (badgeEl) {
            badgeEl.innerHTML = scopeBadgeText;
          }
          if (badgeRow) badgeRow.style.display = 'flex';
        } else if (badgeRow) {
          badgeRow.style.display = 'none';
        }

        // Update fill bar width
        const fillBar = widget.querySelector('.stackup-cart-goal-fill');
        if (fillBar) {
          fillBar.style.setProperty('width', `${progressPercent}%`, 'important');
          if (progressPercent >= 100) {
            fillBar.classList.add('is-completed');
          } else {
            fillBar.classList.remove('is-completed');
          }
        }

        // Update motivational copy (Single centered headline, no floating emoji)
        const titleElem = widget.querySelector('.stackup-cart-goal-title');
        if (titleElem && motivationalHtml) {
          titleElem.innerHTML = motivationalHtml;
        }

        // Render milestone markers along track
        const markersContainer = widget.querySelector('.stackup-cart-goal-markers');
        if (markersContainer && (!markersContainer.dataset.rendered || markersContainer.dataset.tierCount !== String(sortedTiers.length))) {
          markersContainer.dataset.rendered = 'true';
          markersContainer.dataset.tierCount = String(sortedTiers.length);
          markersContainer.innerHTML = '';

          sortedTiers.forEach((tier, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === sortedTiers.length - 1;
            const tierThreshold = (Number(tier.minAmount) || 0) * currencyRate;
            const markerPos = Math.min(100, Math.max(0, (tierThreshold / maxTierAmount) * 100));
            const marker = document.createElement('div');
            marker.className = 'stackup-goal-marker';
            marker.style.left = markerPos + '%';
            marker.dataset.minAmount = String(tierThreshold);
            if (isFirst) marker.dataset.isFirst = 'true';
            if (isLast) marker.dataset.isLast = 'true';

            let icon = '🎯';
            if (tier.hasFreeShipping) icon = '🚚';
            if (tier.freeGift) icon = '🎁';
            if (tier.discountValue > 0) icon = '%';

            const markerTitle = tier.label || `${formatCartGoalMoney(tierThreshold, cartCurrencyCode)}`;
            marker.innerHTML = `
              <div class="stackup-goal-marker-dot" title="${markerTitle}">${icon}</div>
            `;
            markersContainer.appendChild(marker);
          });
        }

        // Update achieved state on markers
        if (markersContainer) {
          markersContainer.querySelectorAll('.stackup-goal-marker').forEach((m) => {
            const min = parseFloat(m.dataset.minAmount) || 0;
            if (progressSubtotal >= min) {
              m.classList.add('is-achieved');
            } else {
              m.classList.remove('is-achieved');
            }
          });
        }
      });

      // Helper to instantly refresh the theme cart DOM via Shopify Section Rendering API (Zero Page Reload)
      async function refreshThemeCartUI(updatedCartData) {
        let updatedSuccessfully = false;

        try {
          const cartItemsElem = document.querySelector('cart-items');
          const cartDrawerElem = document.querySelector('cart-drawer');

          // 1. Gather all section IDs that need live re-rendering
          const sectionsToFetch = new Set(['cart-icon-bubble', 'cart-live-region-text']);

          const mainCartItems = document.getElementById('main-cart-items');
          const mainCartFooter = document.getElementById('main-cart-footer');

          if (mainCartItems) {
            const secId = mainCartItems.dataset?.id || 'main-cart-items';
            sectionsToFetch.add(secId);
          } else {
            sectionsToFetch.add('main-cart-items');
          }

          if (mainCartFooter) {
            const secId = mainCartFooter.dataset?.id || 'main-cart-footer';
            sectionsToFetch.add(secId);
          } else {
            sectionsToFetch.add('main-cart-footer');
          }

          if (cartDrawerElem || document.getElementById('CartDrawer')) {
            sectionsToFetch.add('cart-drawer');
          }

          const sectionsQuery = Array.from(sectionsToFetch).join(',');
          const res = await fetch(`${rootUrl}cart?sections=${encodeURIComponent(sectionsQuery)}`);
          if (res.ok) {
            const sectionsData = await res.json();
            const parser = new DOMParser();

            // A. Update Cart Items (On /cart page)
            if (cartItemsElem && typeof cartItemsElem.renderContents === 'function') {
              try {
                cartItemsElem.renderContents({
                  sections: sectionsData,
                  item_count: updatedCartData?.item_count || 1,
                });
                updatedSuccessfully = true;
              } catch (e) { }
            }

            // Fallback live DOM replacement for /cart page if renderContents didn't run or wasn't a function
            if (!updatedSuccessfully && (mainCartItems || document.querySelector('.cart-items, .cart__items'))) {
              for (const [secKey, secHtml] of Object.entries(sectionsData)) {
                if (typeof secHtml !== 'string') continue;
                const parsedDoc = parser.parseFromString(secHtml, 'text/html');

                if (secKey.includes('items') || secKey.includes('main-cart-items') || parsedDoc.querySelector('.js-contents, .cart-items, .cart__items')) {
                  const newContents = parsedDoc.querySelector('.js-contents') || parsedDoc.getElementById('main-cart-items') || parsedDoc.querySelector('.cart-items, .cart__items');
                  const currentContents = document.querySelector('#main-cart-items .js-contents') || document.getElementById('main-cart-items') || document.querySelector('.cart-items, .cart__items');
                  if (newContents && currentContents) {
                    currentContents.innerHTML = newContents.innerHTML;
                    updatedSuccessfully = true;
                  }
                }

                if (secKey.includes('footer') || secKey.includes('main-cart-footer') || parsedDoc.querySelector('#main-cart-footer, .cart__footer')) {
                  const newFooter = parsedDoc.querySelector('.js-contents') || parsedDoc.getElementById('main-cart-footer') || parsedDoc.querySelector('.cart__footer');
                  const currentFooter = document.querySelector('#main-cart-footer .js-contents') || document.getElementById('main-cart-footer') || document.querySelector('.cart__footer');
                  if (newFooter && currentFooter) {
                    currentFooter.innerHTML = newFooter.innerHTML;
                    updatedSuccessfully = true;
                  }
                }
              }
            }

            // B. Update Cart Drawer silently (NEVER call this.open())
            const isCartPage = Boolean(
              window.location.pathname &&
              window.location.pathname.replace(/\/$/, '').endsWith('/cart')
            );

            // Only update drawer DOM if NOT on /cart page (to avoid any layout interference or opening)
            if (!isCartPage) {
              const targetDrawer = cartDrawerElem || document.getElementById('CartDrawer');
              if (targetDrawer && sectionsData['cart-drawer']) {
                const parsedDoc = parser.parseFromString(sectionsData['cart-drawer'], 'text/html');
                const newInner = parsedDoc.querySelector('.drawer__inner') || parsedDoc.querySelector('cart-drawer') || parsedDoc.getElementById('CartDrawer');
                const currentInner = targetDrawer.querySelector('.drawer__inner') || targetDrawer;
                if (newInner && currentInner) {
                  currentInner.innerHTML = newInner.innerHTML;
                  updatedSuccessfully = true;
                }
              }
            }
          }
        } catch (domErr) {
          console.warn('[StackUp:CartGoal] Live section update notice:', domErr);
        }

        // Notify theme silently without triggering theme drawer popups
        ['cart:refresh'].forEach((evt) => {
          try {
            document.documentElement.dispatchEvent(new CustomEvent(evt, { bubbles: true }));
          } catch (e) { }
        });

        // Safe Fallback: Only on older non-OS2.0 vintage themes where DOM sections could not be updated
        const isCartPage = Boolean(window.location.pathname && window.location.pathname.replace(/\/$/, '').endsWith('/cart'));
        if (isCartPage && !updatedSuccessfully) {
          window.location.reload();
        }
      }

      // ======================================================================
      // SAFE FREE GIFT AUTO-ADD & AUTO-REMOVE STATE MACHINE (Cumulative)
      // ======================================================================
      const eligibleGift = activeGiftTier?.freeGift;
      const eligibleGiftVariantId = eligibleGift?.variantId ? cleanVariantId(eligibleGift.variantId) : null;

      if (eligibleGiftVariantId) {
        // Customer qualified for a gift: check if it's already in the cart (either auto-added or merchant item)
        const matchingGiftInCart = cart && Array.isArray(cart.items)
          ? cart.items.find((item) => {
            const isVarMatch = eligibleGiftVariantId && (
              cleanVariantId(item.id) === eligibleGiftVariantId ||
              cleanVariantId(item.variant_id) === eligibleGiftVariantId
            );
            return isVarMatch;
          })
          : null;

        const isAlreadyInCart = Boolean(matchingGiftInCart);

        if (!isAlreadyInCart && !isCartGoalUpdating) {
          isCartGoalUpdating = true;
          try {
            const addRes = await fetch(`${rootUrl}cart/add.js`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                items: [
                  {
                    id: eligibleGiftVariantId,
                    quantity: 1,
                    properties: {
                      _stackup_free_gift: 'true',
                      _stackup_gift_tier: currentTier?.label || activeGiftTier?.label || 'Cart Goal',
                    },
                  },
                ],
              }),
            });
            const addData = addRes.ok ? await addRes.json() : null;
            await refreshThemeCartUI(addData);
          } catch (giftAddErr) {
            console.warn('[StackUp:CartGoal] Could not auto-add free gift:', giftAddErr);
          } finally {
            setTimeout(() => { isCartGoalUpdating = false; }, 400);
          }
        }
      } else if (freeGiftInCart && !isCartGoalUpdating) {
        // Customer is NOT qualified for gift, but gift is currently in cart: remove it
        isCartGoalUpdating = true;
        try {
          const changeRes = await fetch(`${rootUrl}cart/change.js`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: freeGiftInCart.key || freeGiftInCart.id,
              quantity: 0,
            }),
          });
          const changeData = changeRes.ok ? await changeRes.json() : null;
          await refreshThemeCartUI(changeData);
        } catch (giftRemoveErr) {
          console.warn('[StackUp:CartGoal] Could not auto-remove unqualified free gift:', giftRemoveErr);
        } finally {
          setTimeout(() => { isCartGoalUpdating = false; }, 400);
        }
      }
    } catch (e) {
      console.warn('[StackUp:CartGoal] Error updating cart goal UI:', e);
    }
  }

  function queueCartGoalSync(delay = 100) {
    if (cartGoalSyncTimeout) clearTimeout(cartGoalSyncTimeout);
    cartGoalSyncTimeout = setTimeout(() => {
      updateCartGoalUI();
    }, delay);
  }

  function initStackUpCartGoal() {
    const offers = getCartGoalOffers();
    if (offers && offers.length > 0) {
      queueCartGoalSync(10);
    } else {
      [100, 300, 700, 1500].forEach((delay) => {
        setTimeout(() => {
          const retryOffers = getCartGoalOffers();
          if (retryOffers && retryOffers.length > 0) {
            queueCartGoalSync(30);
          }
        }, delay);
      });
    }

    // Intercept Shopify Ajax Cart fetch & XHR requests to trigger live auto-sync
    if (!window._stackupFetchIntercepted) {
      window._stackupFetchIntercepted = true;
      const originalFetch = window.fetch;
      window.fetch = function () {
        const rawUrl = arguments[0];
        const url = typeof rawUrl === 'string' ? rawUrl : (rawUrl && rawUrl.url ? rawUrl.url : '');
        const isCartApi = typeof url === 'string' && (
          url.includes('/cart/add') ||
          url.includes('/cart/change') ||
          url.includes('/cart/update') ||
          url.includes('/cart/clear')
        );

        const promise = originalFetch.apply(this, arguments);

        if (isCartApi && !isCartGoalUpdating) {
          promise.then(() => {
            queueCartGoalSync(150);
          }).catch(() => { });
        }

        return promise;
      };
    }

    if (!window._stackupXHRIntercepted && window.XMLHttpRequest) {
      window._stackupXHRIntercepted = true;
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this._stackupUrl = url;
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        if (this._stackupUrl && typeof this._stackupUrl === 'string' && (
          this._stackupUrl.includes('/cart/add') ||
          this._stackupUrl.includes('/cart/change') ||
          this._stackupUrl.includes('/cart/update') ||
          this._stackupUrl.includes('/cart/clear')
        )) {
          this.addEventListener('load', () => {
            if (!isCartGoalUpdating) queueCartGoalSync(150);
          });
        }
        return originalSend.apply(this, arguments);
      };
    }

    // Listen for custom theme cart events
    ['cart:updated', 'cart:refresh', 'cart:change', 'cart:build'].forEach((eventName) => {
      window.addEventListener(eventName, () => queueCartGoalSync(100));
      document.addEventListener(eventName, () => queueCartGoalSync(100));
    });

    // Observer to detect when slide-out cart drawer opens in DOM
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' || mutation.type === 'attributes') {
          const target = mutation.target;
          if (target && target.nodeType === 1) {
            const tag = target.tagName ? target.tagName.toLowerCase() : '';
            const className = typeof target.className === 'string' ? target.className.toLowerCase() : '';
            if (
              tag === 'cart-drawer' ||
              className.includes('drawer') ||
              className.includes('cart') ||
              target.id === 'CartDrawer'
            ) {
              queueCartGoalSync(80);
              break;
            }
          }
        }
      }
    });

    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'open', 'active', 'aria-hidden'],
      });
    } catch { }
  }

  // Ensure init runs on DOMContentLoaded and immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStackUpWidgets);
  } else {
    initStackUpWidgets();
  }
  window.addEventListener('load', initStackUpWidgets);

  // Restore interactive button state when returning via browser Back/Forward cache (bfcache)
  window.addEventListener('pageshow', function () {
    resetAllStackUpButtons();
  });

  // Shopify Theme Editor & Dynamic Section Reload support
  document.addEventListener('shopify:section:load', initStackUpWidgets);
  document.addEventListener('shopify:section:select', initStackUpWidgets);
  document.addEventListener('shopify:block:select', initStackUpWidgets);
  document.addEventListener('shopify:block:deselect', initStackUpWidgets);
})();
