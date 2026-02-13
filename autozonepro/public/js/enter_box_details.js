frappe.ui.form.on('Packing List', {
    refresh(frm) {
        set_item_filter(frm);
        show_fill_button(frm);
        update_remaining_qty(frm);
        setup_table_watchers(frm);
        update_totals(frm);
    },

    delivery_note(frm) {
        if (frm.doc.delivery_note) {
            load_dn_items(frm);
        } else {
            frm.clear_table('table_ttya');
            frm.clear_table('table_hqkk');
            frm.clear_table('custom_box_summary');
            frm.refresh_fields();
            set_item_filter(frm);  // reset filter when delivery note is cleared
        }
        show_fill_button(frm);
        update_totals(frm);
    },

    table_hqkk_add(frm) {
        update_totals(frm);
    },

    table_hqkk_remove(frm) {
        update_totals(frm);
        cleanup_empty_boxes(frm);
    },

    before_save(frm) {
        update_totals(frm);
        const missing = get_missing_items(frm);
        if (missing.length) {
            frappe.msgprint({
                title: __("Cannot Save – Items Missing"),
                message: __("The following items from the Delivery Note are not fully packed:<br><ul><li>{0}</li></ul>", [
                    missing.map(m => `${m.item_name} (Need ${m.need}, Packed ${m.packed})`).join('</li><li>')
                ]),
                indicator: "red"
            });
            frappe.validated = false;
            return;
        }
        frappe.show_alert({ message: __("All items packed – Saving…"), indicator: "green" });
    }
});

// Packaging Details Events
frappe.ui.form.on('Packaging Details', {
    table_hqkk_remove(frm) {
        update_remaining_qty(frm);
        cleanup_empty_boxes(frm);
        update_totals(frm);
    },

    quantity(frm) {
        update_remaining_qty(frm);
        update_totals(frm);
    },

    box_number(frm) {
        update_remaining_qty(frm);
        cleanup_empty_boxes(frm);
        update_totals(frm);
    }
});

// --- Helper Functions ---
function update_totals(frm) {
    const box_numbers = new Set((frm.doc.table_hqkk || []).map(r => r.box_number).filter(Boolean));
    const total_boxes = box_numbers.size;
    const total_qty = (frm.doc.table_hqkk || []).reduce((sum, r) => sum + (r.quantity || 0), 0);
    frm.set_value('total_boxes', total_boxes);
    frm.set_value('total_qty', total_qty);
    frm.refresh_field('total_boxes');
    frm.refresh_field('total_qty');
}

function set_item_filter(frm) {
    frm.set_query('item', 'table_hqkk', function(doc, cdt, cdn) {
        const items = (frm.doc.table_ttya || []).map(r => r.item).filter(Boolean);
        return {
            filters: [['name', 'in', items.length ? items : ['-']]]
        };
    });
    // Force grid refresh to apply the new query immediately
    if (frm.fields_dict.table_hqkk?.grid) {
        frm.fields_dict.table_hqkk.grid.refresh();
    }
}

function load_dn_items(frm) {
    if (!frm.doc.delivery_note) return;
    frappe.call({
        method: 'frappe.client.get',
        args: { doctype: 'Delivery Note', name: frm.doc.delivery_note },
        callback(r) {
            const dn = r.message;
            if (!dn?.items?.length) {
                frappe.msgprint(__('No items in the selected Delivery Note.'));
                return;
            }
            frm.clear_table('table_ttya');
            dn.items.forEach(itm => {
                const row = frm.add_child('table_ttya');
                row.item = itm.item_code;
                row.item_name = itm.item_name;
                row.qty = itm.qty;
                row.uom = itm.uom;
                row.remaining_qty = itm.qty;
            });
            frm.refresh_field('table_ttya');
            set_item_filter(frm);          // Apply filter after loading items
            update_remaining_qty(frm);
            show_fill_button(frm);
            update_totals(frm);
        }
    });
}

function update_remaining_qty(frm) {
    if (!frm.doc.table_ttya) return;
    frm.doc.table_ttya.forEach(inv => inv.remaining_qty = inv.qty);
    (frm.doc.table_hqkk || []).forEach(pack => {
        const inv = frm.doc.table_ttya.find(r => r.item === pack.item);
        if (inv) {
            inv.remaining_qty -= (pack.quantity || 0);
            if (inv.remaining_qty < 0) inv.remaining_qty = 0;
        }
    });
    frm.refresh_field('table_ttya');
}

function show_fill_button(frm) {
    frm.remove_custom_button(__('Fill Box Items'));
    if (frm.doc.delivery_note && frm.doc.docstatus === 0 && frm.doc.table_ttya?.length) {
        frm.add_custom_button(__('Fill Box Items'), () => open_box_dialog(frm), __('Actions'));
    }
}

let active_box_dialog = null;

function open_box_dialog(frm) {
    const d = new frappe.ui.Dialog({
        title: __('Pack Items into Boxes'),
        size: 'extra-large',
        fields: [
            { fieldname: 'current_box_section', fieldtype: 'Section Break', label: __('Current Box Details') },
            { fieldname: 'box_number', fieldtype: 'Int', label: __('Box Number'), reqd: 1, default: get_next_box_number(frm) },
            { fieldname: 'box_weight', fieldtype: 'Float', label: __('Box Weight (kg)'), reqd: 1, default: 0 },
            { fieldname: 'available_section', fieldtype: 'Section Break', label: __('Available Items') },
            { fieldname: 'available_items', fieldtype: 'HTML' },
            { fieldname: 'box_items_section', fieldtype: 'Section Break', label: __('Items in Current Box') },
            { fieldname: 'box_items', fieldtype: 'Table', cannot_add_rows: false, cannot_delete_rows: false, in_place_edit: true, data: [], fields: [
                { fieldname: 'item', fieldtype: 'Link', options: 'Item', label: 'Item Code', in_list_view: 1, reqd: 1, get_query() {
                    const avail = get_available_items(frm);
                    return { filters: [['name', 'in', avail.map(a => a.item) || ['-']]] };
                }},
                { fieldname: 'quantity', fieldtype: 'Float', label: 'Pack Qty', reqd: 1, in_list_view: 1, onchange: function() {
                    const row = this.grid.get_row(this.doc.idx - 1);
                    if (row && row.doc.item) {
                        const avail = get_available_qty_for_item(frm, row.doc.item);
                        const old = (frm.doc.table_hqkk || []).filter(r => r.box_number == d.get_value('box_number') && r.item == row.doc.item).reduce((s, r) => s + (r.quantity || 0), 0);
                        const max = avail + old;
                        if (this.value > max) {
                            frappe.msgprint({
                                title: __('Quantity Exceeds Available'),
                                message: __('Cannot pack {0} units of <b>{1}</b>. Maximum available: {2}', [this.value, row.doc.item, max]),
                                indicator: 'red'
                            });
                            this.set_value(0);
                            frappe.validated = false;
                            throw new Error(__('Quantity exceeds available stock'));
                        }
                    }
                    setTimeout(() => {
                        update_dialog_available_items(frm, d);
                    }, 100);
                }}
            ]}
        ],
        primary_action_label: __('Save Box & Continue'),
        primary_action(values) {
            if (save_box(frm, values, d)) {
                const next = values.box_number + 1;
                d.set_value('box_number', next);
                d.set_value('box_weight', 0);
                d.fields_dict.box_items.df.data = [];
                d.fields_dict.box_items.grid.refresh();
                render_available_items(frm, d);
                frappe.show_alert({ message: __('Box {0} saved – ready for Box {1}', [values.box_number, next]), indicator: 'green' });
                if (!frm.doc.table_ttya.some(r => r.remaining_qty > 0)) {
                    frappe.msgprint({ title: __('All Items Packed'), message: __('You can now close the dialog and save the Packing List.'), indicator: 'green' });
                }
                update_totals(frm);
            }
        },
        secondary_action_label: __('Close'),
        secondary_action() {
            active_box_dialog = null;
            d.hide();
        }
    });

    active_box_dialog = d;

    // Setup watchers for table changes
    const box_items_grid = d.fields_dict.box_items.grid;
    box_items_grid.wrapper.on('click', '.grid-remove-rows, .grid-row-check', function() {
        setTimeout(() => {
            update_dialog_available_items(frm, d);
        }, 100);
    });

    d.fields_dict.box_number.df.onchange = () => {
        const bn = d.get_value('box_number');
        const box = (frm.doc.custom_box_summary || []).find(b => b.box_number == bn);
        d.set_value('box_weight', box ? box.weight_kg : 0);
        const existing = (frm.doc.table_hqkk || [])
            .filter(r => r.box_number == bn)
            .map((r, idx) => ({
                idx: idx + 1,
                item: r.item,
                quantity: r.quantity || 0,
                __islocal: 1,
                __unsaved: 1
            }));
        d.fields_dict.box_items.df.data = existing;
        d.fields_dict.box_items.grid.df.data = existing;
        d.fields_dict.box_items.grid.refresh();
        if (existing.length > 0) {
            setTimeout(() => {
                d.fields_dict.box_items.grid.refresh();
            }, 100);
        }
        update_remaining_qty(frm);
        render_available_items(frm, d);
    };

    render_available_items(frm, d);
    d.show();
    d.$wrapper.on('hidden.bs.modal', () => {
        active_box_dialog = null;
        update_totals(frm);
    });
}

function update_dialog_available_items(frm, dialog) {
    if (!dialog) return;
    const dialog_items = dialog.get_value('box_items') || [];
    const current_box = dialog.get_value('box_number');
    const temp_remaining = {};
    (frm.doc.table_ttya || []).forEach(inv => {
        temp_remaining[inv.item] = inv.qty;
    });
    (frm.doc.table_hqkk || []).forEach(pack => {
        if (pack.box_number != current_box && temp_remaining[pack.item] !== undefined) {
            temp_remaining[pack.item] -= (pack.quantity || 0);
        }
    });
    dialog_items.forEach(item => {
        if (item.item && temp_remaining[item.item] !== undefined) {
            temp_remaining[item.item] -= (item.quantity || 0);
        }
    });
    const avail = (frm.doc.table_ttya || [])
        .map(r => ({
            item: r.item,
            item_name: r.item_name,
            remaining_qty: Math.max(0, temp_remaining[r.item] || 0)
        }))
        .filter(r => r.remaining_qty > 0 || dialog_items.some(di => di.item === r.item));
    let html = `<div style="max-height:200px;overflow-y:auto;border:1px solid #d1d8dd;border-radius:4px;padding:10px;">`;
    if (!avail.length) {
        html += `<p class="text-center text-muted">All items packed!</p>`;
    } else {
        html += `<table class="table table-sm table-bordered"><thead><tr>
                    <th>Item</th><th>Name</th><th>Remaining</th>
                 </tr></thead><tbody>`;
        avail.forEach(i => {
            const rowClass = i.remaining_qty === 0 ? 'text-muted' : '';
            html += `<tr class="${rowClass}">
                        <td><strong>${i.item}</strong></td>
                        <td>${i.item_name || ''}</td>
                        <td><strong>${i.remaining_qty || 0}</strong></td>
                     </tr>`;
        });
        html += `</tbody></table>`;
    }
    html += `</div>`;
    dialog.fields_dict.available_items.$wrapper.html(html);
}

function save_box(frm, vals, dialog) {
    const box = vals.box_number,
          weight = vals.box_weight,
          items = vals.box_items || [];
    if (weight === undefined || weight === null || weight <= 0) {
        frappe.msgprint({
            title: __('Missing Box Weight'),
            message: __('Please enter the weight of Box {0} before saving.', [box]),
            indicator: 'red'
        });
        return false;
    }
    if (!items.length) {
        frappe.msgprint({ title: __('No Items'), message: __('Add at least one item.'), indicator: 'red' });
        return false;
    }
    for (const itm of items) {
        if (!itm.quantity || itm.quantity <= 0) {
            frappe.msgprint({ title: __('Invalid Qty'), message: __('Enter a valid quantity for {0}', [itm.item]), indicator: 'red' });
            return false;
        }
        const avail = get_available_qty_for_item(frm, itm.item);
        const old = (frm.doc.table_hqkk || []).filter(r => r.box_number == box && r.item == itm.item).reduce((s, r) => s + (r.quantity || 0), 0);
        if (itm.quantity > avail + old) {
            frappe.msgprint({
                title: __('Quantity Exceeds Available'),
                message: __('Cannot pack {0} units of <b>{1}</b>. Maximum available: {2}', [itm.quantity, itm.item, avail + old]),
                indicator: 'red'
            });
            return false;
        }
    }
    frm.doc.table_hqkk = (frm.doc.table_hqkk || []).filter(r => r.box_number != box);
    items.forEach(itm => {
        const row = frm.add_child('table_hqkk');
        row.box_number = box;
        row.item = itm.item;
        row.quantity = itm.quantity;
        row.box_weight = weight;
        const inv = frm.doc.table_ttya.find(r => r.item === itm.item);
        if (inv) row.uom = inv.uom;
    });
    const summary = (frm.doc.custom_box_summary || []).find(b => b.box_number == box);
    if (summary) {
        summary.weight_kg = weight;
    } else {
        const b = frm.add_child('custom_box_summary');
        b.box_number = box;
        b.weight_kg = weight;
    }
    frm.refresh_field('table_hqkk');
    frm.refresh_field('custom_box_summary');
    update_remaining_qty(frm);
    update_totals(frm);
    return true;
}

function get_next_box_number(frm) {
    const used = (frm.doc.table_hqkk || []).map(r => r.box_number).filter(Boolean);
    return used.length ? Math.max(...used) + 1 : 1;
}

function get_available_items(frm) {
    return (frm.doc.table_ttya || []).filter(r => r.remaining_qty > 0);
}

function render_available_items(frm, dialog) {
    const avail = get_available_items(frm);
    let html = `<div style="max-height:200px;overflow-y:auto;border:1px solid #d1d8dd;border-radius:4px;padding:10px;">`;
    if (!avail.length) {
        html += `<p class="text-center text-muted">All items packed!</p>`;
    } else {
        html += `<table class="table table-sm table-bordered"><thead><tr>
                    <th>Item</th><th>Name</th><th>Remaining</th>
                 </tr></thead><tbody>`;
        avail.forEach(i => {
            html += `<tr>
                        <td><strong>${i.item}</strong></td>
                        <td>${i.item_name || ''}</td>
                        <td><strong>${i.remaining_qty || 0}</strong></td>
                     </tr>`;
        });
        html += `</tbody></table>`;
    }
    html += `</div>`;
    dialog.fields_dict.available_items.$wrapper.html(html);
}

function get_available_qty_for_item(frm, item_code) {
    const inv = frm.doc.table_ttya.find(r => r.item === item_code);
    return inv ? inv.remaining_qty : 0;
}

function cleanup_empty_boxes(frm) {
    if (!frm.doc.custom_box_summary || !frm.doc.table_hqkk) return;
    const used = new Set((frm.doc.table_hqkk || []).map(r => r.box_number).filter(Boolean));
    const toRemove = [];
    frm.doc.custom_box_summary.forEach(b => {
        if (!used.has(b.box_number)) toRemove.push(b.name);
    });
    if (toRemove.length) {
        frm.doc.custom_box_summary = frm.doc.custom_box_summary.filter(b => !toRemove.includes(b.name));
        frm.refresh_field('custom_box_summary');
        frappe.show_alert({ message: __('Removed {0} empty box(es)', [toRemove.length]), indicator: 'blue' });
    }
}

function get_missing_items(frm) {
    const missing = [];
    (frm.doc.table_ttya || []).forEach(inv => {
        const packed = (frm.doc.table_hqkk || []).filter(p => p.item === inv.item).reduce((s, p) => s + (p.quantity || 0), 0);
        if (packed < inv.qty) {
            missing.push({ item: inv.item, item_name: inv.item_name || inv.item, need: inv.qty, packed: packed });
        }
    });
    return missing;
}

function setup_table_watchers(frm) {
    const grid = frm.fields_dict.table_hqkk?.grid;
    if (!grid) return;
    grid.wrapper.off('click', '.grid-row-check').on('click', '.grid-row-check', () => {
        setTimeout(() => {
            update_remaining_qty(frm);
            cleanup_empty_boxes(frm);
            update_totals(frm);
        }, 100);
    });
}