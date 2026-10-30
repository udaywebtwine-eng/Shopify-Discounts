/**
 * StackUp Bundles - Storefront Interactivity
 * Supports Single & Multi-Product Bundles with Dynamic Pricing, Variant Changes, Stock Alerts, and Direct Checkout.
 */

(function () {
  function initStackUpWidgets() {
    const isEmbedActive = !!document.querySelector('[data-stackup-embed-active]') || window.StackUpAppEmbedActive === true;
    if (!isEmbedActive) {
      document.querySelectorAll('.stackup-paired-widget').forEach((w) => {
        w.style.setProperty('display', 'none', 'important');
      });
      return;
    }

    const widgets = document.querySelectorAll('.stackup-paired-widget');
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

      function formatMoney(cents) {
        return '$' + (cents / 100).toFixed(2);
      }

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

          // Toggle visual styling for unchecked state
          if (isChecked) {
            subItem.classList.remove('is-unchecked');
          } else {
            subItem.classList.add('is-unchecked');
          }

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStackUpWidgets);
  } else {
    initStackUpWidgets();
  }

  // Shopify Theme Editor & Dynamic Section Reload support
  document.addEventListener('shopify:section:load', initStackUpWidgets);
  document.addEventListener('shopify:section:select', initStackUpWidgets);
  document.addEventListener('shopify:block:select', initStackUpWidgets);
  document.addEventListener('shopify:block:deselect', initStackUpWidgets);
})();
