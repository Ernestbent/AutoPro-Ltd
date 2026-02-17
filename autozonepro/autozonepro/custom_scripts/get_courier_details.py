import frappe
import json
from frappe import _


@frappe.whitelist()
def create_courier_details(sales_order, first_name, surname, tel_no, vehicle_no, packing_list=None, box_rows=None):
    """Create a Courier Details record linked to the given Sales Order"""

    # Log for debugging
    frappe.log_error(f"create_courier_details called with sales_order: {sales_order}")

    # Validate required fields
    if not first_name or not surname or not tel_no or not vehicle_no:
        frappe.throw(_("All courier fields are required"))

    # Check if Courier Details already exists for this Sales Order
    existing = frappe.get_all(
        "Courier Details",
        filters={"sales_order": sales_order},
        fields=["name"],
        limit_page_length=1
    )

    if existing:
        frappe.log_error(f"Courier Details already exist for Sales Order {sales_order}: {existing[0].name}")
        return {"name": existing[0].name, "already_exists": True}

    # Build full name
    full_name = f"{first_name} {surname}".strip()

    # Parse and map box rows from Packing List → Box Summary Table
    parsed_box_rows = []
    if box_rows:
        try:
            rows = json.loads(box_rows) if isinstance(box_rows, str) else box_rows
            for row in rows:
                parsed_box_rows.append({
                    "doctype": "Box Summary Table",
                    "box_number": row.get("box_number", 0),  # Int
                    "weight_kg": row.get("weight_kg", 0),    # Float
                    "expense": row.get("expense", 0)         # Currency
                })
        except Exception as e:
            frappe.log_error(f"Error parsing box_rows for {sales_order}: {str(e)}")

    try:
        doc = frappe.get_doc({
            "doctype": "Courier Details",
            "first_name": first_name,
            "surname": surname,
            "full_name": full_name,
            "tel_no": tel_no,
            "vehicle_no": vehicle_no,
            "sales_order": sales_order,
            "box_summary": parsed_box_rows  # ✅ correct fieldname from your doctype
        })

        doc.insert(ignore_permissions=True)
        frappe.db.commit()

        return {"name": doc.name, "already_exists": False}

    except Exception as e:
        frappe.db.rollback()
        frappe.log_error(f"Error creating Courier Details for Sales Order {sales_order}: {str(e)}")
        frappe.throw(_("Failed to create Courier Details: {0}").format(str(e)))