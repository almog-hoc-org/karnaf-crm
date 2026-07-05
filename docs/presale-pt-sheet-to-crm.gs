/**
 * Karnaf — פריסייל פתח תקווה (פרויקט סיני)
 * Google Sheet → CRM (make-intake bridge).
 *
 * Setup (one time):
 *   1. בגיליון: Extensions → Apps Script. הדבק את הקובץ הזה.
 *   2. Project Settings (גלגל שיניים) → Script Properties → Add property:
 *        name:  MAKE_INTAKE_KEY
 *        value: <המפתח מהקובץ ~/.config/karnaf/make_intake_key>
 *   3. Triggers (שעון) → Add Trigger:
 *        function: sendNewLeadsToCrm | event source: Time-driven |
 *        Minutes timer | Every 5 minutes.
 *   4. (אופציונלי, למיידיות) Add Trigger נוסף: event source: From spreadsheet,
 *        event type: On change → אותה פונקציה.
 *   5. הרץ פעם אחת ידנית (Run) ואשר הרשאות.
 *
 * עמודות הגיליון (לפי הסדר הקיים):
 *   A חותמת זמן | B שם מלא | C טלפון | D אימייל | E סוג דירה | F תור הליד | G סטאטוס ליד
 * העמודה H ("CRM") משמשת סימון שנשלח — אל תמחק/תזיז.
 */

var CRM_ENDPOINT = 'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/make-intake';
var CRM_SOURCE = 'presale_form';
var PROJECT_NAME = 'פריסייל פתח תקווה — פרויקט סיני';
var INTEREST_TOPIC = 'פריסייל פתח תקווה';
var MARKER_COL = 8; // H

function sendNewLeadsToCrm() {
  var token = PropertiesService.getScriptProperties().getProperty('MAKE_INTAKE_KEY');
  if (!token) throw new Error('חסר MAKE_INTAKE_KEY ב-Script Properties');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row[MARKER_COL - 1]) continue; // already sent

    var fullName = String(row[1] || '').trim();
    var phone = normalizePhone(row[2]);
    var email = String(row[3] || '').trim();
    var aptType = String(row[4] || '').trim();
    if (!phone && !email) continue; // nothing usable

    var payload = {
      full_name: fullName,
      phone: phone,
      email: email,
      presale_project: PROJECT_NAME,
      interest_topic: INTEREST_TOPIC,
      notes: aptType ? ('סוג דירה: ' + aptType) : '',
      apartment_type: aptType
    };

    var url = CRM_ENDPOINT + '?token=' + encodeURIComponent(token) +
              '&source=' + encodeURIComponent(CRM_SOURCE);
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = resp.getResponseCode();
    var ok = code >= 200 && code < 300;
    sheet.getRange(r + 1, MARKER_COL)
         .setValue((ok ? 'נשלח ' : 'שגיאה ' + code + ' ') +
                   Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'dd/MM HH:mm'));
  }
}

function normalizePhone(v) {
  var p = String(v == null ? '' : v).replace(/[^0-9+]/g, '');
  if (/^5\d{8}$/.test(p)) p = '0' + p;       // 5XXXXXXXX → 05XXXXXXXX (lost leading 0)
  if (/^9725\d{8}$/.test(p)) p = '0' + p.slice(3);
  if (/^\+9725\d{8}$/.test(p)) p = '0' + p.slice(4);
  return p;
}
