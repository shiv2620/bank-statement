// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const csv = require("csv-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const DB_FILE = path.join(__dirname, "data.db");
const db = new sqlite3.Database(DB_FILE);

// Ensure columns exist (adds cheque_no & narration if not present)
function ensureEntryColumns() {
  db.all("PRAGMA table_info(entries)", (err, cols) => {
    if (err) return console.error("PRAGMA error:", err);
    const names = (cols || []).map(c => c.name);
    if (!names.includes("cheque_no")) {
      db.run("ALTER TABLE entries ADD COLUMN cheque_no TEXT", (e) => {
        if (e) console.warn("cheque_no add error (might already exist):", e.message);
      });
    }
    if (!names.includes("narration")) {
      db.run("ALTER TABLE entries ADD COLUMN narration TEXT", (e) => {
        if (e) console.warn("narration add error (might already exist):", e.message);
      });
    }
    if (!names.includes("value_date")) {
      db.run("ALTER TABLE entries ADD COLUMN value_date TEXT", (e) => {
        if (e) console.warn("value_date add error (might already exist):", e.message);
      });
    }
  });
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS account_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      account_no TEXT,
      ifsc TEXT,
      address TEXT,
      branch_name TEXT,
      branch_address TEXT,
      city TEXT,
      pin TEXT,
      micr TEXT,
      customer_id TEXT,
      opening_balance REAL,
      total_debit REAL,
      total_credit REAL,
      closing_balance REAL,
      statement_from TEXT,
      statement_to TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      value_date TEXT,
      description TEXT,
      debit REAL,
      credit REAL,
      balance REAL,
      cheque_no TEXT,
      narration TEXT
    )
  `, (err) => {
    if (err) console.error(err);
    ensureEntryColumns();
  });
});

// File upload for CSV
const upload = multer({ dest: "uploads/" });

// --- UPDATED CSV TEMPLATES (added balance column) ---
const csvTemplates = {
  PNB: "date,cheque_no,withdrawal,deposit,narration,balance\n",
  BANDHAN: "date,value_date,description,amount,dr_cr,balance\n",
  CENTRAL: "post_date,value_date,branch_code,cheque_number,account_description,debit,credit,balance\n",
  ICICI: "txn_date,value_date,description,ref_no,debit,credit,balance\n",
  SBI: "txn_date,value_date,description,ref_no,debit,credit,balance\n",
  AXIS: "txn_date,cheque_no,particulars,debit,credit,init_br,balance\n",
  HDFC: "date,narration,ref_no,withdrawal,deposit,balance\n",
  IDFC: "date,value_date,particulars,cheque_no,debit,credit,balance\n"
};

// --- Download blank CSV template endpoint (unchanged except templates include balance) ---
app.get("/api/download-csv-template/:bank", (req, res) => {
  const { bank } = req.params;
  
  if (!csvTemplates[bank]) {
    return res.status(400).json({ 
      error: "Invalid bank selection",
      availableBanks: Object.keys(csvTemplates)
    });
  }

  const csvContent = csvTemplates[bank];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${bank}_Statement_Template.csv"`);
  res.send(csvContent);
});

// --- Helper: parse number safe (handles commas, empty strings) ---
function parseNumberSafe(val) {
  if (val === undefined || val === null) return 0;
  // remove commas and spaces
  const cleaned = String(val).replace(/,/g, '').trim();
  if (cleaned === '') return 0;
  // if contains parentheses e.g. (1,000) treat as negative
  if (/^\(.*\)$/.test(cleaned)) {
    const inner = cleaned.replace(/^\(|\)$/g, '');
    const n = parseFloat(inner);
    return isNaN(n) ? 0 : -n;
  }
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// --- Upload and parse CSV, compute running balance ---
/*
 Expecting multer middleware `upload` already defined earlier:
   const multer = require('multer');
   const upload = multer({ dest: 'uploads/' });
 And csv-parser & fs available.
*/
app.post('/api/upload-statement/:bank', upload.single('file'), (req, res) => {
  const { bank } = req.params;
  if (!req.file) return res.status(400).json({ ok:false, error: 'No file uploaded' });

  const filePath = req.file.path;

  if (!csvTemplates[bank]) {
    fs.unlinkSync(filePath);
    return res.status(400).json({ ok:false, error: 'Unsupported bank' });
  }

  const results = [];
  let runningBalance = 0;

  // We'll process rows in file order as they come
  fs.createReadStream(filePath)
    .pipe(csvParser())
    .on('data', (row) => {
      try {
        // Normalize keys to trim
        const normalizedRow = {};
        Object.keys(row).forEach(k => {
          normalizedRow[k.trim()] = row[k];
        });

        // Bank-specific extraction logic
        let debit = 0;
        let credit = 0;

        const getVal = (candidates) => {
          for (const c of candidates) {
            if (normalizedRow.hasOwnProperty(c)) return normalizedRow[c];
            // try case-insensitive
            const foundKey = Object.keys(normalizedRow).find(k => k.toLowerCase() === c.toLowerCase());
            if (foundKey) return normalizedRow[foundKey];
          }
          return undefined;
        };

        // handle specific banks
        switch (bank) {
          case 'PNB':
            debit = parseNumberSafe(getVal(['withdrawal', 'withdrawals', 'debit']));
            credit = parseNumberSafe(getVal(['deposit', 'deposits', 'credit']));
            break;

          case 'BANDHAN':
            // amount + dr_cr
            {
              const amt = parseNumberSafe(getVal(['amount', 'Amount']));
              const drcr = (getVal(['dr_cr','dr/cr','dr cr','cr_dr','type']) || '').toString().trim().toUpperCase();
              if (drcr.startsWith('D')) debit = amt;
              else if (drcr.startsWith('C')) credit = amt;
              else {
                // fallback: if amount positive, assume credit; negative -> debit
                if (amt < 0) debit = Math.abs(amt);
                else credit = amt;
              }
            }
            break;

          case 'CENTRAL':
          case 'ICICI':
          case 'SBI':
          case 'IDFC':
          case 'AXIS':
            debit = parseNumberSafe(getVal(['debit','withdrawals','withdrawal']));
            credit = parseNumberSafe(getVal(['credit','deposit','deposits']));
            break;

          case 'HDFC':
            debit = parseNumberSafe(getVal(['withdrawal','withdrawals','debit']));
            credit = parseNumberSafe(getVal(['deposit','deposits','credit']));
            break;

          default:
            // generic fallback: try to find any debit/credit-like columns
            debit = parseNumberSafe(getVal(['debit','withdrawal','withdrawals']));
            credit = parseNumberSafe(getVal(['credit','deposit','deposits']));
            break;
        }

        // Compute running balance: prev + credit - debit
        runningBalance = +(runningBalance + credit - debit).toFixed(2);

        // Add balance to row (as string/number)
        const outRow = { ...normalizedRow, balance: runningBalance };

        // Optionally ensure standard fields exist
        outRow._parsed_debit = debit;
        outRow._parsed_credit = credit;
        outRow.balance = runningBalance;

        results.push(outRow);
      } catch (errRow) {
        // ignore row-level parse errors but continue
        console.error('Row parse error', errRow);
      }
    })
    .on('end', () => {
      // cleanup uploaded file
      try { fs.unlinkSync(filePath); } catch (e) {}
      res.json({ ok: true, bank, data: results });
    })
    .on('error', (err) => {
      try { fs.unlinkSync(filePath); } catch (e) {}
      res.status(500).json({ ok:false, error: err.message });
    });
});



// --- Account Info API ---
app.get("/api/account", (req, res) => {
  db.get("SELECT * FROM account_info LIMIT 1", (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || {});
  });
});

app.post("/api/account", (req, res) => {
  const {
    name, account_no, ifsc, address, branch_name, branch_address, city, pin, micr,
    customer_id, opening_balance, total_debit, total_credit, closing_balance, statement_from, statement_to
  } = req.body;

  db.get("SELECT * FROM account_info LIMIT 1", (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    if (row) {
      db.run(
        `UPDATE account_info
         SET name=?, account_no=?, ifsc=?, address=?, branch_name=?, branch_address=?, city=?, pin=?, micr=?,
             customer_id=?, opening_balance=?, total_debit=?, total_credit=?, closing_balance=?, statement_from=?, statement_to=?
         WHERE id=?`,
        [name, account_no, ifsc, address, branch_name, branch_address, city, pin, micr, customer_id, opening_balance, total_debit, total_credit, closing_balance, statement_from, statement_to, row.id],
        (err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ message: "Account info updated" });
        }
      );
    } else {
      db.run(
        `INSERT INTO account_info
          (name, account_no, ifsc, address, branch_name, branch_address, city, pin, micr, customer_id, opening_balance, total_debit, total_credit, closing_balance, statement_from, statement_to)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [name, account_no, ifsc, address, branch_name, branch_address, city, pin, micr, customer_id, opening_balance, total_debit, total_credit, closing_balance, statement_from, statement_to],
        (err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ message: "Account info saved" });
        }
      );
    }
  });
});

// --- Entries API ---
app.get("/api/entries", (req, res) => {
  db.all("SELECT * FROM entries ORDER BY id ASC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post("/api/entry", (req, res) => {
  const { date, value_date, description, debit, credit, cheque_no, narration } = req.body;

  db.get("SELECT balance FROM entries ORDER BY id DESC LIMIT 1", (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    let lastBalance = row ? parseFloat(row.balance) : (req.body.opening_balance ? parseFloat(req.body.opening_balance) : 0);
    let newBalance = lastBalance - (debit ? parseFloat(debit) : 0) + (credit ? parseFloat(credit) : 0);

    db.run(
      `INSERT INTO entries (date, value_date, description, debit, credit, balance, cheque_no, narration)
       VALUES (?,?,?,?,?,?,?,?)`,
      [date || null, value_date || null, description || null, debit || null, credit || null, newBalance, cheque_no || null, narration || null],
      function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ id: this.lastID, date, value_date, description, debit, credit, cheque_no, narration, balance: newBalance });
      }
    );
  });
});

app.put("/api/entry/:id", (req, res) => {
  const { id } = req.params;
  const { date, value_date, description, debit, credit, balance, cheque_no, narration } = req.body;

  db.run(
    `UPDATE entries SET date=?, value_date=?, description=?, debit=?, credit=?, balance=?, cheque_no=?, narration=? WHERE id=?`,
    [date, value_date, description, debit, credit, balance, cheque_no || null, narration || null, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Entry updated", id });
    }
  );
});

app.delete("/api/entry/:id", (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM entries WHERE id=?", id, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Entry deleted", id });
  });
});

// --- CSV Import ---
app.post("/api/import-csv", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => results.push(row))
    .on("end", () => {
      let lastBalance = 0;
      const stmt = db.prepare(`INSERT INTO entries
        (date, value_date, description, debit, credit, balance, cheque_no, narration)
        VALUES (?,?,?,?,?,?,?,?)`);

      results.forEach((r) => {
        let debit = r.debit ? parseFloat(r.debit) : 0;
        let credit = r.credit ? parseFloat(r.credit) : 0;
        let newBalance = lastBalance - debit + credit;

        stmt.run(
            r.date || "",
            r.value_date || r.date || null,
            r.description || r.narration || "",
            debit || null,
            credit || null,
            newBalance,
            r.cheque_no || null,
            r.narration || null
        );

        lastBalance = newBalance;
      });

      stmt.finalize();
      try { fs.unlinkSync(req.file.path); } catch(e) {}
      res.json({
  message: "CSV imported successfully",
  count: results.length,
  transactions: results,
});
    });
});

// ----------------- PDF helpers -----------------
function applyDemoWatermark(doc) {
  // Big translucent SAMPLE on the page center
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  doc.save();
  doc.font('Helvetica-Bold').fontSize(70);
  doc.fillColor('gray', 0.12);
  doc.rotate(-45, { origin: [pageW/2, pageH/2] });
  doc.rotate(45, { origin: [pageW/2, pageH/2] }); // reset rotation
  doc.restore();
  doc.fillColor('black');
}

// Generic function to draw header logo safely
function drawLogoIfExists(doc, filename, x, y, width) {
  if (fs.existsSync(path.join(__dirname, "uploads", filename))) {
    try {
      doc.image(path.join(__dirname, "uploads", filename), x, y, { width });
    } catch (e) {
      // ignore image errors
    }
  }
}

// ----------------- Bank Templates -----------------
const bankTemplates = {
  PNB: (doc, account, entries) => {
  const fs = require("fs");
  const path = require("path");

  // --- Header with PNB Logo and Colors (FIRST PAGE ONLY) ---
  // Maroon header bar
  doc.rect(0, 0, doc.page.width, 45).fill("#8B1538");
  
  if (fs.existsSync(path.join(__dirname, "uploads", "PNB.jpg"))) {
    try { 
      doc.image(path.join(__dirname, "uploads", "PNB.jpg"), 0, 0, { width: 620 });
    } catch (e) {}
  } else {
    // Fallback - White text on maroon
    doc.fillColor("white").fontSize(16).font("Helvetica-Bold");
    doc.text("पंजाब नेशनल बैंक", 220, 10);
    doc.fontSize(14).font("Helvetica");
    doc.text("punjab national bank", 420, 12);
    doc.fontSize(8);
    doc.text("...the name you can bank upon!", 520, 28);
  }
  
  
  doc.fillColor("black");

  // --- Title ---
  let y = 80;
  doc.fontSize(12).font("Helvetica").fillColor("black");
  doc.text(`Account Statement For Account:${account.account_no || "-"}`, 65, y, { align: "center" });

  y += 75;

  // --- Branch Details ---
  doc.fontSize(11).font("Helvetica-Bold");
  doc.text("Branch Details", 35, y);
  
  y += 15;
  doc.fontSize(9).font("Helvetica");
  doc.text("Branch Name:", 35, y);
  doc.text(account.branch_name || "-", 120, y);
  
  y += 14;
  doc.text("Bank Address:", 35, y);
  doc.text(account.branch_address || "-", 120, y);
  
  y += 14;
  if (account.branch_address2) {
    doc.text("", 120, y);
    doc.text(account.branch_address2, 120, y);
    y += 14;
  }
  
  doc.text("City:", 35, y);
  doc.text(account.city || "-", 120, y);
  
  y += 14;
  doc.text("Pin:", 35, y);
  doc.text(account.pin || "-", 120, y);
  
  y += 14;
  doc.text("IFSC Code:", 35, y);
  doc.text(account.ifsc || "-", 120, y);
  
  y += 14;
  doc.text("MICR Code :", 35, y);
  doc.text(account.micr || "-", 120, y);

  y += 25;

  // --- Customer Details ---
  doc.fontSize(11).font("Helvetica-Bold");
  doc.text("Customer Details", 35, y);
  
  y += 15;
  doc.fontSize(9).font("Helvetica");
  doc.text("Customer Name:", 35, y);
  doc.text(account.name || "-", 130, y);
  
  y += 14;
  doc.text("Joint Account Holder 1:", 35, y);
  doc.text(account.jt_holder1 || "", 150, y);
  
  y += 14;
  doc.text("Joint Account Holder 2:", 35, y);
  doc.text(account.jt_holder2 || "", 150, y);
  
  y += 14;
  doc.text("Joint Account Holder 3:", 35, y);
  doc.text(account.jt_holder3 || "", 150, y);
  
  y += 14;
  doc.text("Customer Address:", 35, y);
  doc.text(account.address || "-", 130, y);
  
  y += 14;
  doc.text("City:", 35, y);
  doc.text(account.city || "-", 130, y);
  
  y += 14;
  doc.text("Pin:", 35, y);
  doc.text(account.pin || "-", 130, y);
  
  y += 14;
  doc.text("Nominee :", 35, y);
  doc.text(account.nominee || "", 130, y);

  y += 25;

  // --- Statement Period ---
  doc.fontSize(10).font("Helvetica");
  doc.text(`Statement Period  :`, 35, y);
  doc.text(`${account.statement_from || "-"}`, 150, y);
  doc.text(`to`, 230, y);
  doc.text(`${account.statement_to || "-"}`, 265, y);

  y += 30;

  // --- Helper: Amount Formatter ---
  const formatAmount = (val) => {
    if (!val) return "";
    let num = parseFloat(String(val).replace(/,/g, ""));
    return isNaN(num) ? "" : num.toFixed(2);
  };

  // --- Table Header Function (ONLY FOR FIRST PAGE) ---
  function drawTableHeader(yPos) {
    const left = 35;
    const colWidths = [65, 65, 75, 75, 90, 175];
    const headers = ["Transaction\nDate", "Cheque\nNumber", "Withdrawal", "Deposit", "Balance", "Narration"];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    // Draw header background
    doc.rect(left, yPos, tableWidth, 26)
       .lineWidth(1)
       .fillAndStroke("#f5f5f5", "#000000");

    // Draw header text
    let x = left;
    doc.fontSize(9).font("Helvetica-Bold").fillColor("black");
    
    headers.forEach((h, i) => {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, yPos).lineTo(x, yPos + 26).stroke();
      }
      
      doc.text(h, x + 4, yPos + 6, { 
        width: colWidths[i] - 8, 
        align: "center",
        lineGap: -1
      });
      x += colWidths[i];
    });

    // Draw right border
    doc.moveTo(x, yPos).lineTo(x, yPos + 26).stroke();
    
    doc.fillColor("black").font("Helvetica");
    return { left, colWidths, headerBottom: yPos + 26, tableWidth };
  }

  // --- Draw first header (ONLY ON FIRST PAGE) ---
  let table = drawTableHeader(y);
  let tableY = table.headerBottom;
  let currentPage = 1;
  let isFirstPage = true;

  // Define table structure for continuation pages (no header)
  const tableLeft = 35;
  const tableColWidths = [65, 65, 75, 75, 90, 175];
  const tableWidth = tableColWidths.reduce((a, b) => a + b, 0);

  // --- Table Rows ---
  entries.forEach((r, index) => {
    // Calculate row height
    const narrationText = r.narration || r.description || "-";
    const narrationHeight = doc.heightOfString(narrationText, {
      width: tableColWidths[5] - 8,
      align: "left"
    });
    let rowHeight = Math.max(narrationHeight + 8, 22);

    // --- page break check ---
    if (tableY + rowHeight > doc.page.height - 80) {
      doc.addPage();
      currentPage++;
      isFirstPage = false;
      
      // NO header on continuation pages - just title and continue table
      let newY = 40;
      doc.fontSize(12).font("Helvetica").fillColor("black");
      doc.text(`Account Statement For Account:${account.account_no || "-"}`, 0, newY, { align: "center" });
      
      tableY = newY + 40; // Start table directly without header
    }

    let x = tableLeft;
    const cols = [
      r.date || r.txn_date || "-",
      r.cheque_no || "",
      formatAmount(r.debit) || formatAmount(r.withdrawal),
      formatAmount(r.credit) || formatAmount(r.deposit),
      r.balance ? formatAmount(r.balance) + " Cr." : "",
      narrationText
    ];

    // Draw row border
    doc.rect(tableLeft, tableY, tableWidth, rowHeight).stroke();

    // --- draw cells ---
    for (let i = 0; i < cols.length; i++) {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();
      }

      // Text alignment - right for amounts (columns 2-4), left for others
      const align = (i >= 2 && i <= 4) ? "right" : "left";
      const padding = align === "right" ? 4 : 4;
      
      doc.fontSize(8).font("Helvetica").text(String(cols[i]), x + padding, tableY + 5, { 
        width: tableColWidths[i] - 8,
        align: align
      });
      
      x += tableColWidths[i];
    }

    // Draw right border
    doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();

    tableY += rowHeight;
    doc.y = tableY;
  });

  // Draw bottom border
  doc.moveTo(tableLeft, tableY)
     .lineTo(tableLeft + tableWidth, tableY)
     .stroke();

  // --- Footer text ONLY ON LAST PAGE ---
  drawFooterText(doc, tableY + 20);

  // --- Page Number ---
  doc.fontSize(9).fillColor("gray");
  doc.text(`Page No ${currentPage}`, 0, doc.page.height - 30, { align: "right", width: doc.page.width - 40 });
  doc.fillColor("black");

  // --- Helper function to draw footer disclaimers ---
  function drawFooterText(doc, startY) {
    doc.fontSize(7).font("Helvetica").fillColor("black");
    
    doc.text(
      "Unless constituent notifies the bank immediately of any discrepancy found by him in his statement of",
      35, startY
    );
    doc.text(
      "Account, it will be taken that he has found the account correct.",
      35, startY + 10
    );
    
    startY += 25;
    doc.text(
      "*COMPUTER GENERATED ENTERIES SHOWN IN THE STATEMENT OF ACCOUNT DO NOT REQUIRE ANY",
      35, startY
    );
    doc.text(
      "AUTHENTICATION / INITIAL FROM THE BANK OFFICIAL.PLEASE DO NOT ACCEPT ANY MANUAL ENTRY IN",
      35, startY + 10
    );
    doc.text(
      "YOUR COMPUTER GENERATED STATEMENT OF ACCOUNT",
      35, startY + 20
    );
    
    startY += 35;
    doc.text(
      "* PLEASE ENSURE THAT ALL THE CHEQUE LEAVES IN YOUR CUSTODY ARE DULY BRANDED WITH YOUR",
      35, startY
    );
    doc.text(
      "16 DIGITS ACCOUNT NUMBER",
      35, startY + 10
    );
    
    startY += 25;
    doc.text(
      "* CUSTOMERS ARE REQUESTED IN THEIR OWN INTEREST NOT TO ISSUE CHEQUES WITHOUT",
      35, startY
    );
    doc.text(
      "ADEQUATE CLEAR FUNDS /ARRANGEMENTS. SUCH CHEQUES CAN BE RETURNED WITHOUT MAKING",
      35, startY + 10
    );
    doc.text(
      "ANY FURTHER REFERENCE TO THEM.",
      35, startY + 20
    );
    
    startY += 35;
    doc.text(
      "* PLEASE MAINTAIN MINIMUM AVERAGE BALANCE,TO AVOID LEVY OF CHARGES.",
      35, startY
    );
    
    startY += 15;
    doc.text(
      "*Pls note Penal interest may be charged in loan accounts due to financial reasons such as over",
      35, startY
    );
    doc.text(
      "drawings, non receipt of install on the rates prescribed by bank from time to time and for non financial",
      35, startY + 10
    );
    doc.text(
      "reasons like non submission of , QMS forms, non adherence to terms and conditions etc.",
      35, startY + 20
    );
    
    startY += 35;
    doc.text("Abbreviations are as under:", 35, startY);
    doc.text(
      "BR: Branch Name , Csh: Cash , Clg: Clearing , ISO: Inter Sol(##)",
      35, startY + 10
    );
    doc.text(
      "QAB:Quarterly Average Balances , LF Chq :Ledger Folio Charges , Intl: Interest , Chrg: Charges",
      35, startY + 20
    );
    doc.text(
      "Ret:Returning , Chq: Cheque , SI: Standing Instruction , Stk Stmt: Stock Statement , Trf: Transfer , POSP:POINT OF SALE",
      35, startY + 30
    );
  }
},
BANDHAN: (doc, account, entries) => {
 
  if (fs.existsSync(path.join(__dirname, "uploads", "BANDHAN.png"))) {
    try {
      doc.image(path.join(__dirname, "uploads", "BANDHAN.png"), doc.page.width - 590, 20, { width: 580 });
    } catch (e) { }
  } else {
    // Fallback: Navy blue box with white text
    doc.rect(doc.page.width - 320, 15, 280, 50).fill("#1e3a5f");
    doc.fillColor("white").fontSize(24).font("Helvetica-Bold");
    doc.text("Bandhan", doc.page.width - 270, 42);
    doc.fontSize(20).font("Helvetica");
    doc.text("Bank", doc.page.width - 270, 65);
  }
 
  doc.fillColor("black");
 
  // --- Title ---
  doc.fontSize(16).font("Helvetica-Bold").fillColor("black");
  doc.text("Current and Savings Account Statement", 0, 120, { align: "center", underline: true });
 
  doc.moveDown(3);
 
  // --- Customer Information (Left side) ---
  let y = 180;
  doc.fontSize(10).font("Helvetica").fillColor("black");
 
  doc.text((account.name || "").toUpperCase(), 40, y);
  y += 14;
 
  if (account.father_name) {
    doc.text(`S/O ${account.father_name.toUpperCase()}`, 40, y);
    y += 14;
  }
 
  if (account.address) {
    doc.text(account.address.toUpperCase(), 40, y);
    y += 14;
  }
 
  if (account.address2) {
    doc.text(account.address2.toUpperCase(), 40, y);
    y += 14;
  }
 
  if (account.city) {
    doc.text(`${account.city}, ${account.state || ""}`, 40, y);
    y += 14;
  }
 
  if (account.pin) {
    doc.text(`${account.pin}, INDIA`, 40, y);
    y += 14;
  }
 
  // --- Statement Date (Right aligned) ---
  doc.fontSize(9).text(
    `Account Statement as on ${account.statement_date || account.statement_to || "-"}`,
    0, 280, { align: "right", width: doc.page.width - 40 }
  );
 
  // --- Customer Account Details Section ---
  y = 320;
  doc.fontSize(12).font("Helvetica-Bold").fillColor("#1e3a5f");
  doc.text("Customer Account Details", 40, y);
 
  y += 25;
 
  // --- Details Table ---
  const detailsData = [
    ["Account No", account.account_no || "-"],
    ["Account Type", account.account_type || "Savings account"],
    ["Branch Details", account.branch_address || "-"],
    ["Customer ID / CIF", account.customer_id || account.cif || "-"],
    ["IFSC", account.ifsc || "-"],
    ["MICR Code", account.micr || "-"],
    ["Nomination Registered", account.nominee_registered || "YES"],
    ["Joint Holder Names", account.jt_holder || ""],
    ["Statement period", `From ${account.statement_from || "-"} to ${account.statement_to || "-"}`]
  ];
 
  const detailsLeft = 40;
  const detailsWidth = doc.page.width - 80;
  const labelWidth = 180;
 
  doc.fontSize(9).font("Helvetica").fillColor("black");
 
  // Draw outer border for details table
  doc.rect(detailsLeft, y, detailsWidth, detailsData.length * 26).stroke();
  
  detailsData.forEach(([label, value], index) => {
    const rowY = y + (index * 26);
   
    // Draw horizontal line between rows (except for first row)
    if (index > 0) {
      doc.moveTo(detailsLeft, rowY)
         .lineTo(detailsLeft + detailsWidth, rowY)
         .stroke();
    }
   
    // Draw vertical separator
    doc.moveTo(detailsLeft + labelWidth, rowY)
       .lineTo(detailsLeft + labelWidth, rowY + 26)
       .stroke();
   
    // Draw label (bold)
    doc.font("Helvetica-Bold").text(label, detailsLeft + 5, rowY + 8, { width: labelWidth - 10 });
   
    // Draw value
    doc.font("Helvetica").text(value, detailsLeft + labelWidth + 5, rowY + 8, {
      width: detailsWidth - labelWidth - 10
    });
  });
 
  y += (detailsData.length * 26) + 30;
 
  // --- Statement Details Section ---
  doc.fontSize(12).font("Helvetica-Bold").fillColor("#1e3a5f");
  doc.text("Statement Details", 300, y);
 
  y += 25;
 
  // --- Transaction Table Header ---
  function drawTableHeader(startY) {
    const left = 40;
    const colWidths = [90, 90, 130, 75, 55, 75];
    const headers = ["Transaction Date", "Value Date", "Description", "Amount", "Dr / Cr", "Balance"];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
 
    // Draw header background (dark blue)
    doc.rect(left, startY, tableWidth, 24)
       .fillAndStroke("#1e3a5f", "#1e3a5f");
 
    // Draw header text (white)
    let x = left;
    doc.fontSize(9).font("Helvetica-Bold").fillColor("white");
   
    headers.forEach((h, i) => {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, startY).lineTo(x, startY + 24).stroke("#ffffff");
      }
     
      doc.text(h, x + 5, startY + 7, {
        width: colWidths[i] - 10,
        align: "left"
      });
      x += colWidths[i];
    });
 
    // Draw right border
    doc.moveTo(x, startY).lineTo(x, startY + 24).stroke("#ffffff");
   
    doc.fillColor("black");
    return { left, colWidths, headerBottom: startY + 24, tableWidth };
  }
 
  let table = drawTableHeader(y);
  let tableY = table.headerBottom;
 
  // --- Transaction Rows ---
  doc.font("Helvetica");
  entries.forEach((r, idx) => {
    // Calculate row height
    const descText = r.description || r.particulars || "-";
    const descHeight = doc.heightOfString(descText, {
      width: table.colWidths[2] - 10,
      align: "left"
    });
    let rowHeight = Math.max(descHeight + 10, 28);
 
    // Page break check
    if (tableY + rowHeight > doc.page.height - 120) {
      // Draw red line at bottom before page break
      const footerY = doc.page.height - 30;
      doc.rect(0, footerY, doc.page.width, 30).fill("#D32F2F");
      doc.fillColor("black");
      
      doc.addPage();
     
      // Redraw header
      if (fs.existsSync(path.join(__dirname, "uploads", "BANDHAN.png"))) {
        try {
          doc.image(path.join(__dirname, "uploads", "BANDHAN.png"), doc.page.width - 590, 20, { width: 580 });
        } catch (e) { }
      }
     
      table = drawTableHeader(100);
      tableY = table.headerBottom;
    }
 
    // Prepare column values
    const cols = [
      r.txn_date || r.date || "-",
      r.value_date || r.txn_date || r.date || "-",
      descText,
      r.amount ? `INR ${Number(r.amount).toFixed(2)}` :
                 (r.debit && Number(r.debit) > 0 ? `INR ${Number(r.debit).toFixed(2)}` :
                 (r.credit && Number(r.credit) > 0 ? `INR ${Number(r.credit).toFixed(2)}` : "-")),
      r.dr_cr || (r.debit && Number(r.debit) > 0 ? "Dr" :
                  r.credit && Number(r.credit) > 0 ? "Cr" : "-"),
      r.balance ? `INR ${Number(r.balance).toFixed(2)}` : "-"
    ];
 
    // Draw row with complete border
    doc.rect(table.left, tableY, table.tableWidth, rowHeight).stroke();
 
    // Draw cells
    let x = table.left;
    for (let i = 0; i < cols.length; i++) {
      // Draw vertical lines between columns
      if (i > 0) {
        doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();
      }
 
      // Text alignment
      const align = "left";
     
      doc.fontSize(8).font("Helvetica").text(String(cols[i]), x + 5, tableY + 6, {
        width: table.colWidths[i] - 10,
        align: align
      });
     
      x += table.colWidths[i];
    }
 
    // Draw right border
    doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();
 
    tableY += rowHeight;
  });
 
  // Draw bottom border of table
  doc.moveTo(table.left, tableY)
     .lineTo(table.left + table.tableWidth, tableY)
     .stroke();
 
  // --- Statement Summary Section ---
  tableY += 30;
  doc.fontSize(12).font("Helvetica-Bold").fillColor("#1e3a5f");
  doc.text("Statement Summary", 40, tableY);
  
  tableY += 25;
  
  // Calculate totals
  let totalCredits = 0;
  let totalDebits = 0;
  let openingBalance = 0;
  let closingBalance = 0;
  
  entries.forEach((entry, idx) => {
    if (idx === 0 && entry.balance) {
      openingBalance = Number(entry.balance);
    }
    if (entry.credit && Number(entry.credit) > 0) {
      totalCredits += Number(entry.credit);
    }
    if (entry.debit && Number(entry.debit) > 0) {
      totalDebits += Number(entry.debit);
    }
    if (idx === entries.length - 1 && entry.balance) {
      closingBalance = Number(entry.balance);
    }
  });
  
  // Summary table
  const summaryLeft = 40;
  const summaryWidth = table.tableWidth;
  const summaryColWidth = summaryWidth / 4;
  const summaryHeaders = ["Opening Balance", "Total Credits", "Total Debits", "Closing Balance"];
  const summaryValues = [
    `INR ${openingBalance.toFixed(2)}`,
    `INR ${totalCredits.toFixed(2)}`,
    `INR ${totalDebits.toFixed(2)}`,
    `INR ${closingBalance.toFixed(2)}`
  ];
  
  // Draw summary header with borders
  doc.rect(summaryLeft, tableY, summaryWidth, 24)
     .fillAndStroke("#1e3a5f", "#1e3a5f");
  
  let summaryX = summaryLeft;
  doc.fontSize(9).font("Helvetica-Bold").fillColor("white");
  summaryHeaders.forEach((h, i) => {
    if (i > 0) {
      doc.moveTo(summaryX, tableY).lineTo(summaryX, tableY + 24).stroke("#ffffff");
    }
    doc.text(h, summaryX + 5, tableY + 7, {
      width: summaryColWidth - 10,
      align: "center"
    });
    summaryX += summaryColWidth;
  });
  
  // Draw right border for header
  doc.moveTo(summaryLeft + summaryWidth, tableY).lineTo(summaryLeft + summaryWidth, tableY + 24).stroke("#ffffff");
  
  tableY += 24;
  
  // Draw summary values with borders
  doc.fillColor("black");
  doc.rect(summaryLeft, tableY, summaryWidth, 24).stroke();
  
  summaryX = summaryLeft;
  doc.fontSize(9).font("Helvetica");
  summaryValues.forEach((v, i) => {
    if (i > 0) {
      doc.moveTo(summaryX, tableY).lineTo(summaryX, tableY + 24).stroke();
    }
    doc.text(v, summaryX + 5, tableY + 7, {
      width: summaryColWidth - 10,
      align: "center"
    });
    summaryX += summaryColWidth;
  });
  
  // Draw right border of summary table
  doc.moveTo(summaryLeft + summaryWidth, tableY).lineTo(summaryLeft + summaryWidth, tableY + 24).stroke();
  
  tableY += 24;
  
  // --- Statement Generated On ---
  tableY += 30;
  doc.fontSize(10).font("Helvetica-Bold").fillColor("#1e3a5f");
  doc.text("Statement generated on", 40, tableY);
  
  tableY += 20;
  doc.fontSize(10).font("Helvetica").fillColor("black");
  const generatedDate = new Date().toISOString().replace('T', ' ').substring(0, 23) + '+0530';
  doc.text(generatedDate, 40, tableY);
  
  // --- Thanking You ---
  tableY += 30;
  doc.fontSize(10).font("Helvetica-Bold").fillColor("#1e3a5f");
  doc.text("Thanking You", 40, tableY);

  tableY += 30;
  doc.font("Helvetica-Bold");
  doc.text("Disclaimer", 40, tableY);

  tableY += 18;
  doc.font("Helvetica-Bold").fillColor("black");
  doc.text("This is a system generated statement", 40, tableY);

  tableY += 40;
  doc.font("Helvetica-Bold").fillColor("#1e3a5f");
  doc.text("*End of Statement*", 250, tableY);
  
  // --- Footer: Red bar at bottom ---
  const footerY = doc.page.height - 30;
  doc.rect(0, footerY, doc.page.width, 30).fill("#D32F2F");
  doc.fillColor("black");
}

,
CENTRAL: (doc, account, entries) => {
  // --- Header with Central Bank Logo ---
  if (fs.existsSync(path.join(__dirname, "uploads", "CBI.png"))) {
    try {
      doc.image(path.join(__dirname, "uploads", "CBI.png"), 3, -10, { width: 250 });
    } catch (e) { }
  } else {
    // Fallback: Draw header with colors
    doc.rect(38, 10, 280, 60).fill("#0066b3");
    doc.fillColor("white").fontSize(14).font("Helvetica-Bold");
    doc.text("सेंट्रल बैंक ऑफ इंडिया", 50, 20);
    doc.fontSize(16).text("Central Bank of India", 50, 38);
    doc.fontSize(8).font("Helvetica").text("CENTRAL TO YOU SINCE 1911", 50, 58);
    doc.fillColor("black");
  }
  doc.moveDown(5);
  // --- Bank Branch Information (Right Aligned) ---
  let y = 75;
  doc.fontSize(9).fillColor("black");
  doc.text("Central Bank of India", 0, y, { align: "right", width: doc.page.width - 10 });
  y += 12;
  doc.font("Helvetica").fontSize(8);
  doc.text((account.branch_name || "").toUpperCase(), 0, y, { align: "right", width: doc.page.width - 10 });
  y += 12;
  doc.text((account.branch_address || "").toUpperCase(), 0, y, { align: "right", width: doc.page.width - 10 });
  y += 12;
  doc.text(`Branch Code: ${account.branch_code || "-"}`, 0, y, { align: "right", width: doc.page.width - 10 });
  y += 12;
  doc.text(`IFSC Code: ${account.ifsc || "-"}`, 0, y, { align: "right", width: doc.page.width - 10 });
  y += 12;
  doc.text(`Account Number: ${account.account_no || "-"}`, 0, y, { align: "right", width: doc.page.width - 10 });
  y += 12;
  doc.text(`Product Type: ${account.product_type || account.account_type || "-"}`, 0, y, { align: "right", width: doc.page.width - 10 });
  // --- Customer Information (Left Side) ---
  y = 200;
  doc.fontSize(10).font("Helvetica-Bold").fillColor("black");
  doc.text((account.name || "").toUpperCase(), 7, y);
  y += 14;
  doc.font("Helvetica").fontSize(9);
  if (account.address) {
    doc.text((account.address || "").toUpperCase(),7, y);
    y += 12;
  }
  if (account.address2) {
    doc.text((account.address2 || "").toUpperCase(), 7, y);
    y += 12;
  }
  if (account.city) {
    doc.text((account.city || "").toUpperCase(), 7, y);
    y += 12;
  }
  if (account.pin) {
    doc.text(account.pin, 7, y);
    y += 12;
  }
  y += 6;
  doc.text(`Statement Date :${account.statement_date || "-"}`, 7, y);
  y += 12;
  if (account.email) {
    doc.text(`Email: ${account.email}`, 7, y);
    y += 12;
  }
  doc.text(`Cleared Balance: ${account.cleared_balance || "0.00"}`, 7, y);
  y += 12;
  doc.text(`Uncleared Amount: ${account.uncleared_amount || "0.00"}`, 7, y);
  y += 12;
  if (account.drawing_power) {
    doc.text(`Drawing Power:`, 7, y);
    y += 12;
  }
  // --- Statement Period ---
  doc.font("Helvetica-Bold");
  doc.text(`STATEMENT OF ACCOUNT from ${account.statement_from || "-"} to ${account.statement_to || "-"}`, 7, y);
  y += 25;
  // --- Table Header ---
  function drawTableHeader(startY) {
    const left = 15;
    const colWidths = [60, 60, 60, 60, 100, 65, 65, 85];
    const headers = ["Post Date", "Value\nDate", "Branch\nCode", "Cheque\nNumber", "Account Description", "Debit", "Credit", "Balance"];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    // Draw header background
    doc.rect(left, startY, tableWidth, 30)
       .lineWidth(1)
       .fillAndStroke("#f5f5f5", "#000000");
    // Draw header text
    let x = left;
    doc.fontSize(8).font("Helvetica-Bold").fillColor("black");
    headers.forEach((h, i) => {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, startY).lineTo(x, startY + 30).stroke();
      }
      doc.text(h, x + 3, startY + 8, {
        width: colWidths[i] - 6,
        align: "center",
        lineGap: -1
      });
      x += colWidths[i];
    });
    // Draw right border
    doc.moveTo(x, startY).lineTo(x, startY + 30).stroke();
    doc.fillColor("black").font("Helvetica");
    return { left, colWidths, headerBottom: startY + 30, tableWidth };
  }
  let table = drawTableHeader(y);
  let tableY = table.headerBottom;
  // --- Transaction Rows ---
  entries.forEach((r, idx) => {
    // Calculate row height
    const descText = r.description || r.account_description || "-";
    const descHeight = doc.heightOfString(descText, {
      width: table.colWidths[4] - 6,
      align: "left"
    });
    let rowHeight = Math.max(descHeight + 10, 24);
    // Page break check
    if (tableY + rowHeight > doc.page.height - 80) {
      doc.addPage();
      // Redraw logo on new page
      if (fs.existsSync(path.join(__dirname, "uploads", "CENTRAL.png"))) {
        try {
          doc.image(path.join(__dirname, "uploads", "CENTRAL.png"), 38, 10, { width: 280 });
        } catch (e) { }
      }
      table = drawTableHeader(100);
      tableY = table.headerBottom;
    }
    // Prepare column values
    const cols = [
      r.post_date || r.txn_date || r.date || "-",
      r.value_date || r.post_date || r.txn_date || r.date || "-",
      r.branch_code || account.branch_code || "-",
      r.cheque_no || r.cheque_number || "",
      descText,
      r.debit && Number(r.debit) > 0 ? Number(r.debit).toFixed(2) : "",
      r.credit && Number(r.credit) > 0 ? Number(r.credit).toFixed(2) : "",
      r.balance ? `${Number(r.balance).toFixed(2)} ${r.balance_type || "CR"}` : "-"
    ];
    // Draw row border
    doc.rect(table.left, tableY, table.tableWidth, rowHeight).stroke();
    // Draw cells
    let x = table.left;
    for (let i = 0; i < cols.length; i++) {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();
      }
      // Text alignment - right for amounts, left for others
      const align = (i >= 5 && i <= 7) ? "right" : "left";
      const padding = align === "right" ? 4 : 3;
      doc.fontSize(7).font("Helvetica").text(String(cols[i]), x + padding, tableY + 5, {
        width: table.colWidths[i] - 7,
        align: align
      });
      x += table.colWidths[i];
    }
    // Draw right border
    doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();
    tableY += rowHeight;
  });
  // Draw bottom border
  doc.moveTo(table.left, tableY)
     .lineTo(table.left + table.tableWidth, tableY)
     .stroke();
  // --- Statement End Notice ---
  tableY += 20;
  doc.fontSize(8).font("Helvetica").fillColor("black");
  doc.text(`* Statement Downloaded By ${account.name || "USER"} on ${new Date().toLocaleString('en-IN', { 
    weekday: 'short', 
    month: 'short', 
    day: '2-digit', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit', 
    timeZone: 'Asia/Kolkata',
    timeZoneName: 'short',
    year: 'numeric'
  })}`, 7, tableY);
  tableY += 30;
  doc.text("Unless a constituent notifies the Bank immediately of any discrepancy found by him in this statement of a/c, it will be taken that he has found the a/c correct.", 7, tableY, {
    width: doc.page.width - 50,
    align: "left"
  });
  tableY += 30;
  doc.font("Helvetica-Bold");
  doc.text("END OF STATEMENT - from Internet Banking.", 7, tableY);
  // --- Footer ---
  doc.moveDown(2);
  doc.fontSize(7).fillColor("gray").font("Helvetica");
  doc.text("This is a computer generated statement", 0, doc.page.height - 50, { align: "center" });
  doc.text(`Page ${doc.page.number}`, 0, doc.page.height - 35, { align: "center" });
  doc.fillColor("black");
}
,
ICICI: (doc, account, entries) => {
  // --- Header with ICICI Logo ---
  if (fs.existsSync(path.join(__dirname, "uploads", "ICICI.png"))) {
    try {
      doc.image(path.join(__dirname, "uploads", "ICICI.png"), 38, 10, { width: 140 });
    } catch (e) { }
  } else {
    // Orange gradient background for logo
    doc.rect(38, 10, 120, 35).fill("#ff6b35");
    doc.fillColor("white").fontSize(18).font("Helvetica-Bold").text("ICICI Bank", 48, 20);
    doc.fillColor("black");
  }

  doc.moveDown(2);

  // --- Statement Title ---
  doc.fontSize(12).fillColor("black").font("Helvetica-Bold");
  doc.text("Detailed", 40);
  doc.text("Statement", 40);
  doc.font("Helvetica");

  doc.moveDown(1);

  // --- Account Details Section (Two Column Layout) ---
  doc.fontSize(9).fillColor("black");
  
  const leftX = 40;
  const rightX = 320;
  let leftY = doc.y;
  let rightY = doc.y;

  // Left Column
  doc.text(`Name:`, leftX, leftY);
  doc.font("Helvetica-Bold").text(`${account.name || "-"}`, leftX + 120, leftY);
  doc.font("Helvetica");
  leftY += 15;

  doc.text(`Address:`, leftX, leftY);
  doc.font("Helvetica-Bold").text(`${account.address || "-"}`, leftX + 120, leftY, { width: 150 });
  doc.font("Helvetica");
  leftY += 30;

  doc.text(`A/C No:`, leftX, leftY);
  doc.font("Helvetica-Bold").text(`${account.account_no || "-"}`, leftX + 120, leftY);
  doc.font("Helvetica");
  leftY += 15;

  doc.text(`Jt. Holder:`, leftX, leftY);
  doc.font("Helvetica-Bold").text(`${account.jt_holder || ""}`, leftX + 120, leftY);
  doc.font("Helvetica");
  leftY += 15;

  doc.text(`Transaction Date from:`, leftX, leftY);
  doc.font("Helvetica-Bold").text(`${account.txn_date_from || "-"}`, leftX + 120, leftY);
  doc.font("Helvetica");
  leftY += 15;

  doc.text(`Transaction Period:`, leftX, leftY);
  doc.font("Helvetica-Bold").text(`From ${account.statement_from || "-"} To ${account.statement_to || "-"}`, leftX + 120, leftY);
  doc.font("Helvetica");
  leftY += 15;

  doc.text(`Statement Request/Download Date:`, leftX, leftY);
  doc.font("Helvetica-Bold").text(`${account.download_date || "-"}`, leftX + 120, leftY);
  doc.font("Helvetica");

  // Right Column
  doc.text(`A/C Branch:`, rightX, rightY);
  doc.font("Helvetica-Bold").text(`${account.branch_name || "-"}`, rightX + 100, rightY);
  doc.font("Helvetica");
  rightY += 15;

  doc.text(`Branch Address:`, rightX, rightY);
  doc.font("Helvetica-Bold").text(`${account.branch_address || "-"}`, rightX + 100, rightY, { width: 150 });
  doc.font("Helvetica");
  rightY += 30;

  doc.text(`A/C Type:`, rightX, rightY);
  doc.font("Helvetica-Bold").text(`${account.account_type || "-"}`, rightX + 100, rightY);
  doc.font("Helvetica");
  rightY += 15;

  doc.text(`Cust ID:`, rightX, rightY);
  doc.font("Helvetica-Bold").text(`${account.cust_id || "-"}`, rightX + 100, rightY);
  doc.font("Helvetica");
  rightY += 15;

  doc.text(`Branch Code:`, rightX, rightY);
  doc.font("Helvetica-Bold").text(`${account.branch_code || "-"}`, rightX + 100, rightY);
  doc.font("Helvetica");
  rightY += 15;

  doc.text(`IFSC Code:`, rightX, rightY);
  doc.font("Helvetica-Bold").text(`${account.ifsc || "-"}`, rightX + 100, rightY);
  doc.font("Helvetica");
  rightY += 15;

  doc.text(`Account Currency:`, rightX, rightY);
  doc.font("Helvetica-Bold").text(`${account.currency || "INR"}`, rightX + 100, rightY);
  doc.font("Helvetica");

  // Move down to clear both columns
  doc.y = Math.max(leftY, rightY) + 20;

  // --- Advanced Search Section ---
  doc.fontSize(10).font("Helvetica-Bold").text("Advanced Search", 40);
  doc.font("Helvetica").fontSize(9);
  doc.moveDown(0.5);

  doc.text(`Amount from:`, 40);
  doc.text(`${account.amount_from || "NA"} To ${account.amount_to || "NA"}`, 180);
  doc.moveDown(0.3);

  doc.text(`Cheque number from:`, 40);
  doc.text(`${account.cheque_from || "NA"} To ${account.cheque_to || "NA"}`, 180);
  doc.moveDown(0.3);

  doc.text(`Transaction remarks:`, 40);
  doc.text(`${account.txn_remarks || ""}`, 180);
  doc.moveDown(0.3);

  doc.text(`Transaction type:`, 40);
  doc.text(`${account.txn_type || "DR"}`, 180);

  doc.moveDown(1.5);

  // --- Horizontal Line ---
  doc.moveDown(1);

  // --- Table Header ---
  function drawTableHeader(yPos) {
    const left = 40;
    const colWidths = [65, 65, 120, 90, 60, 60, 60];
    const headers = ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    // Draw header background
    doc.rect(left, yPos, tableWidth, 20).fillAndStroke("#f0f0f0", "#000");
    
    doc.fillColor("black").fontSize(8).font("Helvetica-Bold");

    // Draw header cells with borders
    let x = left;
    headers.forEach((h, i) => {
      // Draw vertical line before each cell (except first)
      if (i > 0) {
        doc.moveTo(x, yPos).lineTo(x, yPos + 20).stroke();
      }
      
      doc.text(h, x + 2, yPos + 5, { width: colWidths[i] - 4, align: "center" });
      x += colWidths[i];
    });
    
    // Draw right border
    doc.moveTo(x, yPos).lineTo(x, yPos + 20).stroke();

    doc.fillColor("black").font("Helvetica");
    return { left, colWidths, headerBottom: yPos + 20, tableWidth };
  }

  let table = drawTableHeader(doc.y + 10);
  let yPos = table.headerBottom;

  // --- Table Rows (dynamic height) ---
  entries.forEach((r) => {
    // values normalize
    const cols = [
      r.txn_date || "-",
      r.value_date || "-",
      r.description || "-",
      r.ref_no || "-",
      r.debit != null && !isNaN(r.debit) ? Number(r.debit).toFixed(2) : "-",
      r.credit != null && !isNaN(r.credit) ? Number(r.credit).toFixed(2) : "-",
      r.balance != null && !isNaN(r.balance) ? Number(r.balance).toFixed(2) : "-"
    ];

    // calculate row height
    let rowHeight = 0;
    for (let i = 0; i < cols.length; i++) {
      const h = doc.heightOfString(String(cols[i]), {
        width: table.colWidths[i] - 6,
        align: "left"
      });
      rowHeight = Math.max(rowHeight, h + 6);
    }

    // page break
    if (yPos + rowHeight > doc.page.height - doc.page.margins.bottom - 60) {
      doc.addPage();
      table = drawTableHeader(40);
      yPos = table.headerBottom;
    }

    // Draw complete row border first
    doc.rect(table.left, yPos, table.tableWidth, rowHeight).stroke();

    // Draw cells with vertical borders
    let x = table.left;
    doc.fontSize(8);
    for (let i = 0; i < cols.length; i++) {
      // Draw vertical lines between cells
      if (i > 0) {
        doc.moveTo(x, yPos).lineTo(x, yPos + rowHeight).stroke();
      }

      doc.text(String(cols[i]), x + 3, yPos + 3, { width: table.colWidths[i] - 6 });
      x += table.colWidths[i];
    }
    
    // Draw right border
    doc.moveTo(x, yPos).lineTo(x, yPos + rowHeight).stroke();

    yPos += rowHeight;
    doc.y = yPos;
  });

  // --- Page Total Section ---
  yPos += 20;
  
  // Check if we need new page for footer
  if (yPos > doc.page.height - 250) {
    doc.addPage();
    yPos = 60;
  }

  doc.fontSize(10).font("Helvetica-Bold").fillColor("black");
  doc.text("Page Total", 40, yPos);
  yPos += 18;

  doc.fontSize(9).font("Helvetica");
  
  // Calculate totals from entries if not provided
  let openingBal = account.opening_balance || "0.00";
  let totalWithdrawls = account.total_withdrawls || "0.00";
  let totalDeposits = account.total_deposits || "0.00";
  let closingBal = account.closing_balance || "0.00";
  
  if (!account.total_withdrawls || !account.total_deposits) {
    let withdrawlSum = 0, depositSum = 0;
    entries.forEach(e => {
      if (e.debit) withdrawlSum += Number(e.debit);
      if (e.credit) depositSum += Number(e.credit);
    });
    totalWithdrawls = withdrawlSum.toFixed(2);
    totalDeposits = depositSum.toFixed(2);
  }

  doc.text(`Opening Bal:`, 40, yPos);
  doc.text(openingBal, 150, yPos);
  yPos += 14;

  doc.text(`Withdrawls:`, 40, yPos);
  doc.text(totalWithdrawls, 150, yPos);
  yPos += 14;

  doc.text(`Deposits:`, 40, yPos);
  doc.text(totalDeposits, 150, yPos);
  yPos += 14;

  doc.text(`Closing Bal:`, 40, yPos);
  doc.text(closingBal, 150, yPos);
  yPos += 25;

  // --- Legends Section ---
  doc.fontSize(10).font("Helvetica-Bold");
  doc.text("Legends Used in Account Statement", 40, yPos);
  yPos += 18;

  doc.fontSize(8).font("Helvetica");
  const legends = [
    "1. BBPS - Bharat Bill Payment Service",
    "2. BCTT - Banking Cash Transaction Tax",
    "3. BIL - Internet Bill payment or funds transfer to Third party",
    "4. BPAY - Bill payment",
    "5. CCWD - Cardless Cash Withdrawal",
    "6. DTAX - Direct Tax",
    "7. EBA - Transaction on ICICI Direct",
    "8. IDTX - Indirect Tax",
    "9. IMPS - Immediate Payment Service",
    "10. INF - Internet fund transfer in linked accounts",
    "11. INFT - Internal Fund Transfer (Within ICICI Bank)",
    "12. LCCBRN CMS - Local cheque collection",
    "13. LNPY - Linked loan payment",
    "14. MMT - Mobile Money Transfer (Insta FT - IMPS)",
    "15. N chg - NEFT Charges",
    "16. NEFT - National Electronics Funds Transfer System (Other Bank Fund transfer)",
    "17. ONL - Online Shopping transaction (Payment done on third party website)",
    "18. PAC - Personal Accident cover",
    "19. PAVC - Pay any Visa credit card",
    "20. PAYC - Pay to Contact",
    "21. RCHG - Recharge",
    "22. SMO - Smart Money order",
    "23. T Chg - Travel Charges",
    "24. TOP - Mobile recharge",
    "25. UCCBRN CMS - Upcountry cheque collection",
    "26. VAT / MAT / NFS - Cash withdrawal at other bank ATM",
    "27. VPS / IPS - Debit card transaction",
    "28. BIL - To third party is for RIB",
    "29. GIB - Tax & Statutory payment,EPFO, ESIC"
  ];

  legends.forEach(legend => {
    // Check if we need new page
    if (yPos > doc.page.height - 40) {
      doc.addPage();
      yPos = 60;
    }
    
    doc.text(legend, 40, yPos, { width: 520 });
    yPos += 12;
  });

  // --- Page Number at Bottom ---
  doc.fontSize(9).fillColor("gray");
  doc.text(`Page 1 of 2`, doc.page.width - 100, doc.page.height - 40);
  doc.fillColor("black");
}
,

  SBI: (doc, account, entries) => {
  // --- Header with SBI Logo ---
  if (fs.existsSync(path.join(__dirname, "uploads", "SBI.png"))) {
    try {
      doc.image(path.join(__dirname, "uploads", "SBI.png"), 38, 15, { width: 150 });
    } catch (e) { }
  } else {
    // Fallback: Draw SBI logo manually
    doc.save();
    doc.circle(65, 35, 22).fill("#0088cc");
    doc.circle(73, 35, 14).fill("white");
    doc.fillColor("#1a237e").fontSize(28).font("Helvetica-Bold").text("SBI", 95, 20);
    doc.restore();
  }

  doc.moveDown(4);

  // --- Account Details Section ---
  const startY = doc.y;
  doc.fontSize(10).fillColor("black").font("Helvetica");
  
  // Left aligned labels with colons
  const labelX = 40;
  const valueX = 180;
  let currentY = startY;

  // Helper function to draw field
  const drawField = (label, value, isMultiLine = false) => {
    doc.font("Helvetica").text(`${label}`, labelX, currentY);
    doc.text(`: ${value || "-"}`, valueX, currentY, { width: 350 });
    currentY += isMultiLine ? 12 : 14;
  };

  drawField("Account Name", account.name);
  drawField("Address", account.address, true);
  if (account.address2) {
    doc.text(`  ${account.address2}`, valueX, currentY);
    currentY += 12;
  }
  doc.text(`  ${account.city || "-"}-${account.pin || "-"}`, valueX, currentY);
  currentY += 12;
  if (account.district) {
    doc.text(`  DIST-${account.district}`, valueX, currentY);
    currentY += 14;
  }

  currentY += 4; // Extra spacing

  drawField("Date", account.date);
  drawField("Account Number", account.account_no);
  drawField("Account Description", account.account_type);
  drawField("Branch", account.branch_name);
  drawField("Drawing Power", account.drawing_power || "0.00");
  drawField("Interest Rate(% p.a.)", account.interest_rate || "0.00");
  drawField("MOD Balance", account.mod_balance || "0.00");
  drawField("CIF No.", account.cif);
  drawField("IFS Code", account.ifsc);
  drawField("MICR Code", account.micr);
  drawField("Nomination Registered", account.nominee_registered || "Yes");

  // Opening Balance
  let openingBal = "-";
  if (!isNaN(account.opening_balance)) {
    openingBal = Number(account.opening_balance).toFixed(2);
  }
  drawField(`Balance as on ${account.statement_from || "-"}`, openingBal);

  doc.moveDown(1.5);

  // --- Statement Header ---
  doc.fontSize(11).fillColor("black").font("Helvetica-Bold");
  doc.text(`Account Statement from ${account.statement_from || "-"} to ${account.statement_to || "-"}`, 40);
  doc.font("Helvetica");

  doc.moveDown(1);

  // --- Table Header ---
  function drawTableHeader(yPos) {
    const left = 40;
    const colWidths = [50, 50, 120, 100, 70, 70, 70];
    const headers = ["Txn Date", "Value\nDate", "Description", "Ref No./Cheque\nNo.", "Debit", "Credit", "Balance"];

    // Draw header background
    doc.rect(left, yPos, colWidths.reduce((a, b) => a + b, 0), 30)
      .lineWidth(1)
      .fillAndStroke("#ffffff", "#000000");
    
    doc.fillColor("black").fontSize(9).font("Helvetica-Bold");

    let x = left;
    headers.forEach((h, i) => {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, yPos).lineTo(x, yPos + 30).stroke();
      }
      
      doc.text(h, x + 4, yPos + 8, { 
        width: colWidths[i] - 8, 
        align: "left",
        lineGap: -2
      });
      x += colWidths[i];
    });

    // Draw right border
    doc.moveTo(x, yPos).lineTo(x, yPos + 30).stroke();

    doc.fillColor("black").font("Helvetica");
    return { left, colWidths, headerBottom: yPos + 30 };
  }

  let table = drawTableHeader(doc.y);
  let yPos = table.headerBottom;

  // --- Table Rows (dynamic height) ---
  entries.forEach((r, index) => {
    // Normalize values
    const cols = [
      r.txn_date || "-",
      r.value_date || "-",
      r.description || "-",
      r.ref_no || "-",
      r.debit != null && !isNaN(r.debit) && Number(r.debit) > 0 ? Number(r.debit).toFixed(2) : "",
      r.credit != null && !isNaN(r.credit) && Number(r.credit) > 0 ? Number(r.credit).toFixed(2) : "",
      r.balance != null && !isNaN(r.balance) ? Number(r.balance).toFixed(2) : "-"
    ];

    // Calculate row height based on description
    let rowHeight = 0;
    for (let i = 0; i < cols.length; i++) {
      const h = doc.heightOfString(String(cols[i]), {
        width: table.colWidths[i] - 8,
        align: i === 2 ? "left" : "left"
      });
      rowHeight = Math.max(rowHeight, h + 10);
    }

    // Minimum row height
    rowHeight = Math.max(rowHeight, 28);

    // Page break check
    if (yPos + rowHeight > doc.page.height - 80) {
      doc.addPage();
      table = drawTableHeader(50);
      yPos = table.headerBottom;
    }

    // Draw row background (alternating white)
    doc.rect(table.left, yPos, table.colWidths.reduce((a, b) => a + b, 0), rowHeight)
      .lineWidth(1)
      .stroke("#000000");

    // Draw cells
    let x = table.left;
    doc.fontSize(9).font("Helvetica");
    
    for (let i = 0; i < cols.length; i++) {
      // Draw vertical lines between columns
      if (i > 0) {
        doc.moveTo(x, yPos).lineTo(x, yPos + rowHeight).stroke();
      }

      // Align numbers to the right, text to the left
      const align = (i >= 4 && i <= 6) ? "right" : "left";
      const textX = align === "right" ? x + table.colWidths[i] - 8 : x + 4;
      
      doc.text(cols[i], textX, yPos + 6, { 
        width: table.colWidths[i] - 8,
        align: align
      });
      
      x += table.colWidths[i];
    }

    // Draw right border
    doc.moveTo(x, yPos).lineTo(x, yPos + rowHeight).stroke();

    yPos += rowHeight;
    doc.y = yPos;
  });

  // Draw bottom border of table
  doc.moveTo(table.left, yPos)
     .lineTo(table.left + table.colWidths.reduce((a, b) => a + b, 0), yPos)
     .stroke();

  // --- Disclaimer Text (After table ends) ---
  yPos += 30;
  doc.fontSize(8).font("Helvetica").fillColor("black");
  
  doc.text(
    "Please do not share your ATM, Debit/Credit card number, PIN and OTP with anyone over mail, SMS, phone call or any other",
    40, yPos
  );
  doc.text(
    "media. Bank never asks for such information.",
    40, yPos + 10
  );

  yPos += 35;
  doc.text(
    "**This is a computer generated statement and does not require a signature.",
    40, yPos
  );

  // --- Footer ---
  doc.fontSize(8).fillColor("#666666");
  doc.text(`*** End of Statement ***`, 0, doc.page.height - 60, { align: "center" });
  doc.text(`Page ${doc.page.number}`, 0, doc.page.height - 45, { align: "right", width: doc.page.width - 40 });
  doc.fillColor("black");
},

AXIS: (doc, account, entries) => {
  applyDemoWatermark(doc);

  // --- Header: Axis Bank Logo ---
  if (fs.existsSync(path.join(__dirname, "uploads", "AXIS.png"))) {
    try {
      doc.image(path.join(__dirname, "uploads", "AXIS.png"), 180, -58, { width: 250 });
    } catch (e) { }
  } else {
    // Fallback logo
    doc.fontSize(22).fillColor("#A6192E").font("Helvetica-Bold");
    doc.text("AXIS BANK", 350, 25);
    doc.fillColor("black").font("Helvetica");
  }

  // --- Customer Info (Left Side) ---
  let y = 70;
  doc.fontSize(10).font("Helvetica-Bold").fillColor("black");
  doc.text((account.name || "-").toUpperCase(), 40, y);
  
  y += 16;
  doc.font("Helvetica").fontSize(9);
  if (account.father_name) {
    doc.text(`D/O ${account.father_name.toUpperCase()}`, 40, y);
    y += 14;
  }
  
  // Address with pin
  let addressLine = account.address || "-";
  if (account.pin) addressLine += `-${account.pin}`;
  doc.text(addressLine.toUpperCase(), 40, y);
  y += 14;

  // Address line 2
  if (account.address2) {
    doc.text(account.address2.toUpperCase(), 40, y);
    y += 14;
  }

  // City
  if (account.city) {
    doc.text(account.city.toUpperCase(), 40, y);
    y += 14;
  }

  // State
  if (account.state) {
    doc.text(account.state.toUpperCase(), 40, y);
  }

  // --- Customer Info (Right Side) ---
  const rightY = 115;
  doc.fontSize(9).font("Helvetica");
  
  doc.text(`Customer No: ${account.customer_no || "-"}`, 350, rightY, { align: "right" });
  doc.text(`Scheme: ${account.scheme || "EASY ACCESS SALARY"}`, 300, rightY + 14, { align: "right" });
  doc.text(`ACCOUNT`, 440, rightY + 28, { align: "right" });
  doc.text(`Currency: ${account.currency || "INR"}`, 390, rightY + 42, { align: "right" });

  // --- Statement Title ---
  y = 175;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("black");
  doc.text(
    `Statement of Account No: ${account.account_no || "-"} for the period (From: ${account.statement_from || "-"} To: ${account.statement_to || "-"})`,
    40, y, { align: "center", width: 520 }
  );

  // --- Table Setup ---
  const left = 40;
  y += 25;
  const headers = ["Tran Date", "Chq No", "Particulars", "Debit", "Credit", "Balance", "Init.\nBr"];
  const colWidths = [65, 55, 145, 70, 70, 70, 40];
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);

  // --- Draw Table Header ---
  function drawTableHeader(startY) {
    // Draw header background
    doc.rect(left, startY, tableWidth, 24)
       .lineWidth(0.5)
       .fillAndStroke("#ffffff", "#000000");

    // Draw header text
    let x = left;
    doc.fontSize(9).font("Helvetica-Bold").fillColor("black");
    headers.forEach((h, i) => {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, startY).lineTo(x, startY + 24).stroke();
      }
      
      doc.text(h, x + 3, startY + 6, { 
        width: colWidths[i] - 6, 
        align: "left",
        lineGap: -1
      });
      x += colWidths[i];
    });

    // Draw right border
    doc.moveTo(x, startY).lineTo(x, startY + 24).stroke();
    
    return startY + 24;
  }

  let tableY = drawTableHeader(y);

  // --- Opening Balance Row ---
  doc.rect(left, tableY, tableWidth, 20).stroke();
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("OPENING BALANCE", left + 3, tableY + 5, { width: 260 });
  doc.text(account.opening_balance || "200.30", left + tableWidth - 113, tableY + 5, { width: 70, align: "right" });
  tableY += 20;

  // --- Table Rows ---
  doc.font("Helvetica");
  entries.forEach((r, idx) => {
    // Calculate row height
    const particularText = r.particulars || r.description || "-";
    const descHeight = doc.heightOfString(particularText, {
      width: colWidths[2] - 6,
      align: "left"
    });
    let rowHeight = Math.max(descHeight + 8, 18);

    // Page break check
    if (tableY + rowHeight > doc.page.height - 100) {
      doc.addPage();
      applyDemoWatermark(doc);
      tableY = drawTableHeader(60);
    }

    // Prepare column values
    const cols = [
      r.txn_date || r.date || "-",
      r.cheque_no || r.ref_no || "-",
      particularText,
      r.debit && Number(r.debit) > 0 ? Number(r.debit).toFixed(2) : "",
      r.credit && Number(r.credit) > 0 ? Number(r.credit).toFixed(2) : "",
      r.balance ? Number(r.balance).toFixed(2) : "",
      r.init_br || "2144"
    ];

    // Draw row borders
    doc.rect(left, tableY, tableWidth, rowHeight).stroke();

    // Draw cells
    let x = left;
    for (let i = 0; i < cols.length; i++) {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();
      }

      // Align numbers to right, text to left
      const align = (i >= 3 && i <= 6) ? "right" : "left";
      const padding = align === "right" ? 4 : 3;
      
      doc.fontSize(8).text(String(cols[i]), x + padding, tableY + 4, { 
        width: colWidths[i] - 6,
        align: align
      });
      
      x += colWidths[i];
    }

    // Draw right border
    doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();

    tableY += rowHeight;
  });

  // Draw bottom border
  doc.moveTo(left, tableY).lineTo(left + tableWidth, tableY).stroke();

  // --- Transaction Total Row ---
  tableY += 2;
  doc.rect(left, tableY, tableWidth, 20).stroke();
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("TRANSACTION TOTAL", left + 3, tableY + 5, { width: 260 });
  
  // Calculate totals from entries if not provided
  let totalDebit = account.total_debit || "0.00";
  let totalCredit = account.total_credit || "0.00";
  
  if (!account.total_debit || !account.total_credit) {
    let debitSum = 0, creditSum = 0;
    entries.forEach(e => {
      if (e.debit) debitSum += Number(e.debit);
      if (e.credit) creditSum += Number(e.credit);
    });
    totalDebit = debitSum.toFixed(2);
    totalCredit = creditSum.toFixed(2);
  }

  doc.text(totalDebit, left + 265, tableY + 5, { width: 66, align: "right" });
  doc.text(totalCredit, left + 335, tableY + 5, { width: 66, align: "right" });
  tableY += 20;

  // --- Closing Balance Row ---
  doc.rect(left, tableY, tableWidth, 20).stroke();
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("CLOSING BALANCE", left + 3, tableY + 5, { width: 260 });
  doc.text(account.closing_balance || "3843.00", left + tableWidth - 113, tableY + 5, { width: 70, align: "right" });

  // Draw right border for closing balance
  doc.moveTo(left + tableWidth, tableY).lineTo(left + tableWidth, tableY + 20).stroke();

  // --- Footer Disclaimers ---
  tableY += 35;
  
  // Check if we need a new page for footer
  if (tableY > doc.page.height - 350) {
    doc.addPage();
    applyDemoWatermark(doc);
    tableY = 60;
  }

  doc.fontSize(7).font("Helvetica").fillColor("black");
  
  // Disclaimer paragraphs
  const disclaimer1 = "Unless the constituent notifies the bank immediately of any discrepancy found by him/her in this statement of Account, it will be taken that he/she has found the account correct.";
  doc.text(disclaimer1, 40, tableY, { width: 520, align: "justify" });
  tableY += doc.heightOfString(disclaimer1, { width: 520 }) + 8;

  const disclaimer2 = "The closing balance as shown/displayed includes not only the credit balance and / or overdraft limit, but also funds which are under clearing. It excludes the amount marked as lien, if any. Hence the closing balance displayed may not be the effective available balance. For any further clarifications, please contact the Branch.";
  doc.text(disclaimer2, 40, tableY, { width: 520, align: "justify" });
  tableY += doc.heightOfString(disclaimer2, { width: 520 }) + 8;

  const disclaimer3 = "We would like to reiterate that, as a policy, Axis Bank does not ask you to part with/disclose/revalidate of your iConnect passord,login id and debit card number through emails OR phone call Further,we would like to reiterate that Axis Bank shall not be liable for any losses arising from you sharing/disclosing of your login id, password and debit card number to anyone. Please co-operate by forwarding all such suspicious/spam emails, if received by you, to customer.service@axisbank.com";
  doc.text(disclaimer3, 40, tableY, { width: 520, align: "justify" });
  tableY += doc.heightOfString(disclaimer3, { width: 520 }) + 8;

  const disclaimer4 = "REGISTERED OFFICE - AXIS BANK LTD,TRISHUL,Opp. Samartheswar Temple, Near Law Garden, Ellisbridge, Ahmedabad , 380006.This is a system generated output and requires no signature.";
  doc.text(disclaimer4, 40, tableY, { width: 520, align: "justify" });
  tableY += doc.heightOfString(disclaimer4, { width: 520 }) + 15;

  // Legends section
  doc.fontSize(8).font("Helvetica-Bold");
  doc.text("Legends :", 40, tableY);
  tableY += 15;

  doc.font("Helvetica").fontSize(7);
  const legends = [
    { code: "ICONN", desc: "Transaction trough Internet Banking" },
    { code: "VMT-ICON", desc: "Visa Money Transfer through Internet Banking" },
    { code: "AUTOSWEEP", desc: "Transfer to linked fixed deposit" },
    { code: "REV SWEEP", desc: "Interest on Linked fixed Deposit" },
    { code: "SWEEP TRF", desc: "Transfer from Linked Fixed Deposit / Account" },
    { code: "VMT", desc: "Visa Money Transfer through ATM" },
    { code: "CWDR", desc: "Cash Withdrawal through ATM" },
    { code: "PUR", desc: "POS purchase" },
    { code: "TIP/ SCG", desc: "Surcharge on usage of debit card at pumps/railway ticket purchase or hotel tips" },
    { code: "RATE DIFF", desc: "Difference in rates on usage of card internationally" },
    { code: "CLG", desc: "Cheque Clearing Transaction" },
    { code: "EDC", desc: "Credit transaction through EDC Machine" },
    { code: "SETU", desc: "Seamless electronic fund transfer through AXIS Bank" },
    { code: "Int.pd", desc: "Interest paid to customer" },
    { code: "Int.Coll", desc: "Interest collected from the customer" }
  ];

  legends.forEach(legend => {
    // Check if we need new page
    if (tableY > doc.page.height - 40) {
      doc.addPage();
      applyDemoWatermark(doc);
      tableY = 60;
    }
    
    const legendText = `${legend.code.padEnd(20, ' ')} -    ${legend.desc}`;
    doc.text(legendText, 40, tableY, { width: 520, lineBreak: false });
    tableY += 12;
  });

  // End of Statement marker
  tableY += 10;
  doc.fontSize(8).font("Helvetica-Bold");
  doc.text("++++ End of Statement ++++", 0, tableY, { align: "center" });
},
HDFC: (doc, account, entries) => {
  applyDemoWatermark(doc);

  // --- Header with HDFC Logo ---
  if (fs.existsSync(path.join(__dirname, "uploads", "HDFC.jpg"))) {
    try {
      doc.image(path.join(__dirname, "uploads", "HDFC.jpg"), 20, 20, { width: 140 });
    } catch (e) { }
  } else {
    // Fallback logo
    doc.rect(20, 20, 140, 40).fill("#004C8F");
    doc.fillColor("white").fontSize(16).font("Helvetica-Bold");
    doc.text("HDFC BANK", 30, 32);
    doc.fillColor("black");
  }

  // Page number (top right)
  doc.fontSize(8).text(`Page 1 of 1`, doc.page.width - 80, 20);

  // --- Customer Information Box (Left) ---
  const boxY = 80;
  doc.rect(20, boxY, 230, 155).stroke();
  
  doc.fontSize(9).font("Helvetica-Bold");
  doc.text((account.name || "").toUpperCase(), 25, boxY + 8);
  
  doc.fontSize(8).font("Helvetica");
  doc.text(account.address || "-", 25, boxY + 22);
  doc.text(account.address2 || "", 25, boxY + 34);
  doc.text(account.city || "", 25, boxY + 46);
  doc.text(account.state || "", 25, boxY + 58);
  doc.text(account.country || "INDIA", 25, boxY + 70);
  doc.text(account.pin || "", 25, boxY + 82);
  
  doc.moveDown(1);
  doc.text(`JOINT HOLDERS:`, 25, boxY + 108);

  // --- Account Details (Right Side) ---
  const rightX = 300;
  doc.fontSize(8).font("Helvetica");
  
  const accountDetails = [
    ["Account Branch", account.branch_name || ""],
    ["Address", account.branch_address || ""],
    ["", ""],
    ["City", account.branch_city || ""],
    ["State", account.branch_state || ""],
    ["Phone No.", account.branch_phone || ""],
    ["RTGS/NEFT IFSC", `${account.ifsc || ""} MICR :${account.micr || ""}`],
    ["OD Limit", account.od_limit || ""],
    ["Cust ID", `${account.customer_id || ""} Pr.Code : ${account.pr_code || ""} Br.Code :${account.branch_code || ""}`],
    ["Account number", account.account_no || ""],
    ["A/C Open Date", account.opening_date || ""],
    ["Account Status", account.status || ""]
  ];

  let detailY = boxY + 8;
  accountDetails.forEach(([label, value]) => {
    if (label) {
      doc.text(`${label}`, rightX, detailY);
      doc.text(`: ${value}`, rightX + 90, detailY);
    } else {
      doc.text(`: ${value}`, rightX + 90, detailY);
    }
    detailY += 12;
  });

  // --- Nomination and Statement Period ---
  let y = boxY + 165;
  doc.fontSize(8).font("Helvetica");
  doc.text(`Nomination       : ${account.nomination || "Not Registered"}`, 20, y);
  y += 12;
  doc.text(`Statement From: ${account.statement_from || "01/01/23"}`, 20, y);
  doc.text(`To: ${account.statement_to || "31/03/23"}`, 130, y);

  y += 35;

  // --- Transaction Table Header ---
  function drawTableHeader(startY) {
    const left = 20;
    const colWidths = [55, 180, 75, 85, 80, 80];
    const headers = ["Date", "Narration", "Chq / Ref No", "Withdrawal Amount", "Deposit Amount", "Closing Balance*"];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    // Draw header background
    doc.rect(left, startY, tableWidth, 20)
       .lineWidth(1)
       .fillAndStroke("#f5f5f5", "#000000");

    // Draw header text
    let x = left;
    doc.fontSize(8).font("Helvetica-Bold").fillColor("black");
    
    headers.forEach((h, i) => {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, startY).lineTo(x, startY + 20).stroke();
      }
      
      doc.text(h, x + 3, startY + 6, { 
        width: colWidths[i] - 6, 
        align: "left"
      });
      x += colWidths[i];
    });

    // Draw right border
    doc.moveTo(x, startY).lineTo(x, startY + 20).stroke();
    
    doc.fillColor("black").font("Helvetica");
    return { left, colWidths, headerBottom: startY + 20, tableWidth };
  }

  let table = drawTableHeader(y);
  let tableY = table.headerBottom;

  // --- Transaction Rows ---
  entries.forEach((r, idx) => {
    // Calculate row height
    const narrationText = r.narration || r.description || "-";
    const narrationHeight = doc.heightOfString(narrationText, {
      width: table.colWidths[1] - 6,
      align: "left"
    });
    let rowHeight = Math.max(narrationHeight + 8, 22);

    // Page break check
    if (tableY + rowHeight > doc.page.height - 250) {
      doc.addPage();
      applyDemoWatermark(doc);
      
      // Redraw logo
      if (fs.existsSync(path.join(__dirname, "uploads", "HDFC.png"))) {
        try {
          doc.image(path.join(__dirname, "uploads", "HDFC.png"), 20, 20, { width: 140 });
        } catch (e) { }
      }
      
      table = drawTableHeader(80);
      tableY = table.headerBottom;
    }

    // Prepare column values
    const cols = [
      r.date || r.txn_date || "-",
      narrationText,
      r.cheque_no || r.ref_no || "",
      r.debit && Number(r.debit) > 0 ? Number(r.debit).toFixed(2) : (r.withdrawal && Number(r.withdrawal) > 0 ? Number(r.withdrawal).toFixed(2) : "0.00"),
      r.credit && Number(r.credit) > 0 ? Number(r.credit).toFixed(2) : (r.deposit && Number(r.deposit) > 0 ? Number(r.deposit).toFixed(2) : "0.00"),
      r.balance ? Number(r.balance).toFixed(2) : "-"
    ];

    // Draw row border
    doc.rect(table.left, tableY, table.tableWidth, rowHeight).stroke();

    // Draw cells
    let x = table.left;
    for (let i = 0; i < cols.length; i++) {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();
      }

      // Text alignment - right for amounts, left for others
      const align = (i >= 3 && i <= 5) ? "right" : "left";
      const padding = align === "right" ? 4 : 3;
      
      doc.fontSize(7).font("Helvetica").text(String(cols[i]), x + padding, tableY + 5, { 
        width: table.colWidths[i] - 7,
        align: align
      });
      
      x += table.colWidths[i];
    }

    // Draw right border
    doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();

    tableY += rowHeight;
  });

  // Draw bottom border
  doc.moveTo(table.left, tableY)
     .lineTo(table.left + table.tableWidth, tableY)
     .stroke();

  // --- Statement Summary ---
  tableY += 15;
  doc.fontSize(9).font("Helvetica-Bold");
  doc.text("STATEMENT SUMMARY :-", 20, tableY);
  
  tableY += 15;
  doc.fontSize(8).font("Helvetica");
  
  // Calculate totals
  let drCount = 0, crCount = 0, totalCredit = 0;
  entries.forEach(e => {
    if ((e.debit && Number(e.debit) > 0) || (e.withdrawal && Number(e.withdrawal) > 0)) drCount++;
    if (e.credit && Number(e.credit) > 0) {
      crCount++;
      totalCredit += Number(e.credit);
    }
    if (e.deposit && Number(e.deposit) > 0) {
      crCount++;
      totalCredit += Number(e.deposit);
    }
  });

  doc.text(`Opening Balance`, 20, tableY);
  doc.text(`${account.opening_balance || "2323.00"}`, 20, tableY + 12);
  
  doc.text(`Dr Count`, 140, tableY);
  doc.text(`${drCount}`, 140, tableY + 12);
  
  doc.text(`Cr Count`, 280, tableY);
  doc.text(`${crCount}`, 280, tableY + 12);
  
  doc.text(`Credits`, 400, tableY);
  doc.text(`${totalCredit.toFixed(2)}`, 400, tableY + 12);
  
  doc.text(`Closing Balance`, 500, tableY);
  doc.text(`${account.closing_balance || entries[entries.length - 1]?.balance || "0.00"}`, 500, tableY + 12);

  // --- End of Statement ---
  tableY += 40;
  doc.fontSize(10).font("Helvetica-Bold").fillColor("black");
  doc.text("**END OF STATEMENT**", 0, tableY, { align: "center" });

  // --- Footer ---
  const footerY = doc.page.height - 130;
  doc.fontSize(7).font("Helvetica").fillColor("gray");
  doc.text("Generated by: SYSTEM", 20, footerY, { align: "left" });
  doc.text("Requesting Branch code: SYSTEM", 0, footerY, { align: "right", width: doc.page.width - 40 });
  
  doc.moveDown(2);
  doc.fontSize(7).fillColor("#004C8F");
  doc.text("HDFC BANK LIMITED", 0, footerY + 20, { align: "center" });
  doc.fillColor("blue").font("Helvetica");
  doc.text("*Closing Balance does not include the balance of unclearlized amount for hold and uncleared funds.", 0, footerY + 32, { align: "center" });
  
  doc.fillColor("gray");
  doc.text("Contents of this statement will be automatically corrected if any error is expected within 30 days of receipt of statement.", 0, footerY + 44, { align: "center", width: doc.page.width });
  
  doc.fontSize(6);
  doc.text("State account branch GSTIN: 3AAACH7023R1Z1", 0, footerY + 56, { align: "center" });
  doc.text("HDFC Bank GSTIN number details are available at https://www.hdfcbank.com/personal/making-payments/online-tax-payment/goods-and-service-tax", 0, footerY + 66, { align: "center", width: doc.page.width });
  doc.text("Registered Office Address: HDFC Bank House, Senapati Bapat Marg, Lower Parel, Mumbai 400013", 0, footerY + 76, { align: "center" });

  doc.fillColor("black");
}
,

 IDFC: (doc, account, entries) => {
  applyDemoWatermark(doc);

  // --- Header Title ---
  doc.fontSize(14).font('Helvetica-Bold').fillColor("black");
  doc.text('STATEMENT OF ACCOUNT', 40, 20);

  // --- IDFC Logo (Top Right) ---
  if (fs.existsSync(path.join(__dirname, "uploads", "IDFC.png"))) {
    try {
      doc.image(path.join(__dirname, "uploads", "IDFC.png"), doc.page.width - 145, 25, { width: 140 });
    } catch (e) { }
  } else {
    // Fallback logo
    doc.rect(doc.page.width - 180, 25, 140, 50).fill("#8B0000");
    doc.fillColor("white").fontSize(16).font("Helvetica-Bold");
    doc.text("IDFC FIRST", doc.page.width - 170, 35);
    doc.fontSize(14).text("Bank", doc.page.width - 170, 52);
    doc.fillColor("black");
  }

  // --- Customer & Account Info (Top Left) ---
  let y = 50;
  doc.fontSize(9).font('Helvetica').fillColor("black");
  doc.text(`CUSTOMER ID`, 40, y);
  doc.text(`: ${account.customer_id || "-"}`, 160, y);
  
  y += 12;
  doc.text(`ACCOUNT NO`, 40, y);
  doc.text(`: ${account.account_no || "-"}`, 160, y);
  
  y += 12;
  doc.text(`STATEMENT PERIOD : ${account.statement_from || "-"} to ${account.statement_to || "-"}`, 40, y);

  y += 30;

  // --- Customer Name & Address (Left Column) ---
  doc.fontSize(11).font('Helvetica-Bold');
  doc.text((account.name || "").toUpperCase(), 40, y);
  
  y += 14;
  doc.fontSize(9).font('Helvetica');
  if (account.father_name) {
    doc.text(`D/O ${account.father_name}`, 40, y);
    y += 12;
  }
  doc.text(account.address || "-", 40, y);
  y += 12;
  doc.text(`${account.city || "-"} - ${account.pin || "-"}`, 40, y);
  y += 12;
  doc.text(`IFSC : ${account.ifsc || "-"}`, 40, y);
  y += 12;
  doc.text(`MICR Code : ${account.micr || "-"}`, 40, y);

  // --- Account Details (Right Column) ---
  const rightX = 350;
  let rightY = 120;
  
  doc.text(`DATE OF OPENING`, rightX, rightY);
  doc.text(`: ${account.opening_date || "-"}`, rightX + 120, rightY);
  
  rightY += 12;
  doc.text(`ACCOUNT STATUS`, rightX, rightY);
  doc.text(`: ${account.status || "ACTIVE"}`, rightX + 120, rightY);
  
  rightY += 12;
  doc.text(`ACCOUNT TYPE`, rightX, rightY);
  doc.text(`: ${account.account_type || "Corporate Salary"}`, rightX + 120, rightY);
  
  rightY += 12;
  doc.text(`CURRENCY`, rightX, rightY);
  doc.text(`: INR`, rightX + 120, rightY);

  y = Math.max(y, rightY) + 30;

  // --- Summary Box WITH BORDERS ---
  const boxLeft = 40;
  const boxWidth = doc.page.width - 80;
  
  // Header row
  doc.rect(boxLeft, y, boxWidth, 22).stroke();
  doc.fontSize(10).font("Helvetica-Bold");
  
  const colW = boxWidth / 4;
  doc.text('Opening Balance', boxLeft + 5, y + 6, { width: colW - 10, align: 'center' });
  doc.text('Total Debit', boxLeft + colW + 5, y + 6, { width: colW - 10, align: 'center' });
  doc.text('Total Credit', boxLeft + colW * 2 + 5, y + 6, { width: colW - 10, align: 'center' });
  doc.text('Closing Balance', boxLeft + colW * 3 + 5, y + 6, { width: colW - 10, align: 'center' });

  // Draw vertical lines in header
  doc.moveTo(boxLeft + colW, y).lineTo(boxLeft + colW, y + 22).stroke();
  doc.moveTo(boxLeft + colW * 2, y).lineTo(boxLeft + colW * 2, y + 22).stroke();
  doc.moveTo(boxLeft + colW * 3, y).lineTo(boxLeft + colW * 3, y + 22).stroke();

  y += 22;
  
  // Values row WITH BORDERS
  doc.rect(boxLeft, y, boxWidth, 22).stroke();
  doc.fontSize(9).font('Helvetica');
  
  doc.text(account.opening_balance || '0.00', boxLeft + 5, y + 6, { width: colW - 10, align: 'center' });
  doc.text(account.total_debit || '0.00', boxLeft + colW + 5, y + 6, { width: colW - 10, align: 'center' });
  doc.text(account.total_credit || '0.00', boxLeft + colW * 2 + 5, y + 6, { width: colW - 10, align: 'center' });
  doc.text(account.closing_balance || '0.00', boxLeft + colW * 3 + 5, y + 6, { width: colW - 10, align: 'center' });

  // Draw vertical lines in values row
  doc.moveTo(boxLeft + colW, y).lineTo(boxLeft + colW, y + 22).stroke();
  doc.moveTo(boxLeft + colW * 2, y).lineTo(boxLeft + colW * 2, y + 22).stroke();
  doc.moveTo(boxLeft + colW * 3, y).lineTo(boxLeft + colW * 3, y + 22).stroke();

  y += 40;

  // --- Table Header Function (ONLY FIRST PAGE) ---
  function drawTableHeader(startY) {
    const left = 40;
    const colWidths = [57, 57, 175, 61, 55, 55, 55];
    const headers = ["Transaction Date", "Value Date", "Particulars", "Cheque No.", "Debit", "Credit", "Balance"];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    // Draw header background
    doc.rect(left, startY, tableWidth, 24)
       .lineWidth(1)
       .fillAndStroke("#f5f5f5", "#000000");

    // Draw header text
    let x = left;
    doc.fontSize(8).font("Helvetica-Bold").fillColor("black");
    
    headers.forEach((h, i) => {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, startY).lineTo(x, startY + 24).stroke();
      }
      
      doc.text(h, x + 3, startY + 7, { 
        width: colWidths[i] - 6, 
        align: "center"
      });
      x += colWidths[i];
    });

    // Draw right border
    doc.moveTo(x, startY).lineTo(x, startY + 24).stroke();
    
    doc.fillColor("black").font("Helvetica");
    return { left, colWidths, headerBottom: startY + 24, tableWidth };
  }

  // --- Draw Table Header (FIRST PAGE ONLY) ---
  let table = drawTableHeader(y);
  let tableY = table.headerBottom;
  let isFirstPage = true;

  // Define table structure for continuation pages
  const tableLeft = 40;
  const tableColWidths = [57, 57, 175, 61, 55, 55, 55];
  const tableWidth = tableColWidths.reduce((a, b) => a + b, 0);

  // --- Table Rows ---
  entries.forEach((r, idx) => {
    // Calculate row height
    const particularText = r.particulars || r.narration || r.description || "-";
    const particularHeight = doc.heightOfString(particularText, {
      width: tableColWidths[2] - 6,
      align: "left"
    });
    let rowHeight = Math.max(particularHeight + 8, 22);

    // Page break check
    if (tableY + rowHeight > doc.page.height - 80) {
      doc.addPage();
      applyDemoWatermark(doc);
      isFirstPage = false;
      
      // NO HEADER on continuation pages - table continues directly
      tableY = 40;
    }

    // Prepare column values
    const cols = [
      r.date || r.txn_date || "-",
      r.value_date || r.date || r.txn_date || "-",
      particularText,
      r.cheque_no || "",
      r.debit && Number(r.debit) > 0 ? Number(r.debit).toFixed(2) : "",
      r.credit && Number(r.credit) > 0 ? Number(r.credit).toFixed(2) : "",
      r.balance ? Number(r.balance).toFixed(2) : ""
    ];

    // Draw row border
    doc.rect(tableLeft, tableY, tableWidth, rowHeight).stroke();

    // Draw cells
    let x = tableLeft;
    for (let i = 0; i < cols.length; i++) {
      // Draw vertical lines
      if (i > 0) {
        doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();
      }

      // Text alignment - right for amounts, left for others
      const align = (i >= 4 && i <= 6) ? "right" : "left";
      const padding = align === "right" ? 4 : 3;
      
      doc.fontSize(7).font("Helvetica").text(String(cols[i]), x + padding, tableY + 5, { 
        width: tableColWidths[i] - 7,
        align: align
      });
      
      x += tableColWidths[i];
    }

    // Draw right border
    doc.moveTo(x, tableY).lineTo(x, tableY + rowHeight).stroke();

    tableY += rowHeight;
  });

  // Draw bottom border
  doc.moveTo(tableLeft, tableY)
     .lineTo(tableLeft + tableWidth, tableY)
     .stroke();

  // --- Registered Office Text (LAST PAGE ONLY) ---
  tableY += 40;
  doc.fontSize(8).font("Helvetica").fillColor("black");
  doc.text(
    "REGISTERED OFFICE: IDFC FIRST BANK LIMITED, KRM Tower, 7th Floor, No. 1, Harrington Road, Chetpet, Chennai-600031, Tamilnadu, INDIA.",
    40, tableY, { align: "left" }
  );

  // --- Footer with Page Number ---
  doc.fontSize(9).fillColor("gray");
  doc.text(`Page ${doc.page.number} of 2`, 0, doc.page.height - 40, { 
    align: 'right', 
    width: doc.page.width - 40 
  });
  doc.fillColor("black");
}};

// --- Generate PDF ---
app.post("/api/generate-pdf", (req, res) => {
  const { bank = "PNB", account = {}, transactions = [] } = req.body;

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-disposition", `attachment; filename=${bank}-statement.pdf`);
  res.setHeader("Content-type", "application/pdf");
  doc.pipe(res);

  if (bankTemplates[bank]) {
    bankTemplates[bank](doc, account, transactions);
  } else {
    doc.fontSize(14).text("Bank Statement (Sample)", { align: "center" }).moveDown();
    if (account) {
      doc.fontSize(10)
        .text(`Name: ${account.name || ""}`)
        .text(`Account No.: ${account.account_no || ""}`)
        .moveDown();
    }
  }

  doc.end();
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
