// src/App.js
import React, { useState } from "react";
import axios from "axios";

const API = "https://bank-statement-backend-5juy.onrender.com";

// Config for each bank
const BANK_CONFIG = {
  PNB: {
  labels: ["Transaction Date", "Cheque Number", "Withdrawal", "Deposit", "Balance", "Narration"],
  fields: ["date", "cheque_no", "withdrawal", "deposit", "balance", "narration"],
  accountFields: [
    "account_no",
    "branch_name",
    "branch_address",
    "branch_address2",
    "city",
    "pin",
    "ifsc",
    "micr",
    "name",
    "jt_holder1",
    "jt_holder2",
    "jt_holder3",
    "address",
    "nominee",
    "statement_from",
    "statement_to"
  ],
},
  CENTRAL: {
  labels: ["Post Date", "Value Date", "Branch Code", "Cheque Number", "Account Description", "Debit", "Credit", "Balance"],
  fields: ["post_date", "value_date", "branch_code", "cheque_number", "account_description", "debit", "credit", "balance"],
  accountFields: [
    "name",
    "address",
    "address2",
    "city",
    "pin",
    "email",
    "account_no",
    "branch_name",
    "branch_address",
    "branch_code",
    "ifsc",
    "account_type",
    "product_type",
    "statement_date",
    "statement_from",
    "statement_to",
    "cleared_balance",
    "uncleared_amount",
    "drawing_power"
  ],
},
  BANDHAN: {
  labels: ["Transaction Date", "Value Date", "Description", "Amount", "Dr / Cr", "Balance"],
  fields: ["txn_date", "value_date", "description", "amount", "dr_cr", "balance"],
  accountFields: [
    "name",
    "father_name",
    "address",
    "address2",
    "city",
    "state",
    "pin",
    "account_no",
    "account_type",
    "branch_address",
    "customer_id",
    "cif",
    "ifsc",
    "micr",
    "nominee_registered",
    "jt_holder",
    "statement_from",
    "statement_to",
    "statement_date"
  ],
},
  ICICI: {
  labels: ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
  fields: ["txn_date", "value_date", "description", "ref_no", "debit", "credit", "balance"],
  accountFields: ["name","address","account_no","jt_holder","txn_date_from","statement_from","statement_to","download_date","branch_name","branch_address","account_type","cust_id","branch_code","ifsc","currency","amount_from","amount_to","cheque_from","cheque_to","txn_remarks","txn_type"],
},
  SBI: {
    labels: ["Date", "Description", "Debit", "Credit", "Balance"],
    fields: ["date", "description", "debit", "credit", "balance"],
    accountFields: ["name","father_name","address","address2","city","district","pin","date","account_no","account_type","branch_name","drawing_power","interest_rate","mod_balance","cif","ifsc","micr","nominee_registered","opening_balance","closing_balance","statement_from","statement_to"],
  },
  HDFC: {
  labels: ["Date", "Narration", "Chq / Ref No", "Withdrawal Amount", "Deposit Amount", "Closing Balance*"],
  fields: ["date", "narration", "ref_no", "withdrawal", "deposit", "balance"],
  accountFields: [
    "name",
    "address",
    "address2",
    "city",
    "state",
    "country",
    "pin",
    "branch_name",
    "branch_address",
    "branch_address2",
    "branch_city",
    "branch_state",
    "branch_phone",
    "ifsc",
    "micr",
    "od_limit",
    "customer_id",
    "pr_code",
    "branch_code",
    "account_no",
    "opening_date",
    "status",
    "nomination",
    "statement_from",
    "statement_to",
    "opening_balance",
    "closing_balance"
  ],
},
  
  AXIS: {
  labels: ["Tran Date","Chq No","Particulars","Debit","Credit","Balance","Init. Br"],
  fields: ["txn_date","cheque_no","particulars","debit","credit","balance","init_br"],
  accountFields: ["name","father_name","address","city","state","pin","customer_no","scheme","account_type","currency","account_no","ifsc","branch_name","branch_address","opening_balance","total_debit","total_credit","closing_balance","statement_from","statement_to"],
},

  IDFC: {
  labels: ["Transaction Date", "Value Date", "Particulars", "Cheque No.", "Debit", "Credit", "Balance"],
  fields: ["date", "value_date", "particulars", "cheque_no", "debit", "credit", "balance"],
  accountFields: [
    "customer_id",
    "account_no",
    "statement_from",
    "statement_to",
    "name",
    "father_name",
    "address",
    "city",
    "pin",
    "ifsc",
    "micr",
    "opening_date",
    "status",
    "account_type",
    "opening_balance",
    "total_debit",
    "total_credit",
    "closing_balance"
  ],
},
};

function App() {
  const [bank, setBank] = useState("PNB");
  const [account, setAccount] = useState({});
  const [transactions, setTransactions] = useState([]);
  const [file, setFile] = useState(null);
  const [manualTxn, setManualTxn] = useState({});

  // Account Info change
  const handleAccountChange = (e) => {
    setAccount({ ...account, [e.target.name]: e.target.value });
  };

  // Save account info
  const saveAccount = async () => {
    try {
      await axios.post(`${API}/api/account`, { bank, account });
      alert("Account info saved!");
    } catch (err) {
      alert("Error saving account info");
    }
  };

  // Download CSV Template
  const downloadCSVTemplate = async () => {
    try {
      const response = await fetch(`${API}/api/download-csv-template/${bank}`);
      
      if (!response.ok) {
        throw new Error('Failed to download template');
      }
      
      // Get the CSV content
      const blob = await response.blob();
      
      // Create a download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${bank}_Statement_Template.csv`;
      document.body.appendChild(a);
      a.click();
      
      // Cleanup
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      alert(`${bank} CSV template downloaded successfully!`);
    } catch (error) {
      console.error('Error downloading CSV template:', error);
      alert('Failed to download CSV template');
    }
  };

  // CSV Upload
  const handleFileUpload = async () => {
    if (!file) return alert("Please select a file");
    const formData = new FormData();
    formData.append("file", file);
    formData.append("bank", bank);

    try {
      const res = await axios.post(`${API}/api/import-csv`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setTransactions(res.data.transactions || []);

      alert(`CSV Uploaded! 
      Entries: ${res.data.count}
      Total Debit: ${res.data.totalDebit}
      Total Credit: ${res.data.totalCredit}
      Opening Balance: ${res.data.openingBalance}
      Closing Balance: ${res.data.closingBalance}`);
    } catch (err) {
      alert("Error uploading CSV");
    }
  };

  // Manual Transaction field change
  const handleTxnChange = (e) => {
    setManualTxn({ ...manualTxn, [e.target.name]: e.target.value });
  };

  // Add Manual Transaction
  const addManualTxn = () => {
    setTransactions([...transactions, manualTxn]);
    setManualTxn({});
  };

  // Clear all transactions
  const clearTransactions = () => {
    if (!window.confirm("Clear all transactions?")) return;
    setTransactions([]);
  };

  // Download PDF
  const downloadPDF = async () => {
    try {
      const res = await axios.post(`${API}/api/generate-pdf`, {
        bank,
        account,
        transactions,
      }, { responseType: "blob" });

      // Download the PDF
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${bank}_Statement.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error generating PDF");
    }
  };

  // Totals
  const totalDebit = transactions.reduce((sum, t) => sum + (parseFloat(t.debit || t.withdrawal) || 0), 0);
  const totalCredit = transactions.reduce((sum, t) => sum + (parseFloat(t.credit || t.deposit) || 0), 0);

  return (
    <div style={{ padding: 20, fontFamily: 'Arial, sans-serif' }}>
      <h2>🏦 Bank Statement Generator</h2>

      {/* Bank Selection */}
      <div style={{ marginBottom: 20, padding: 15, background: '#f5f5f5', borderRadius: 8 }}>
        <label style={{ fontWeight: 'bold', marginRight: 10 }}>Select Bank: </label>
        <select 
          value={bank} 
          onChange={(e) => setBank(e.target.value)}
          style={{ padding: 8, fontSize: 14, borderRadius: 4, border: '1px solid #ccc' }}
        >
          {Object.keys(BANK_CONFIG).map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>

      {/* Account Info */}
      <div style={{ marginTop: 20, border: "1px solid #ccc", padding: 15, borderRadius: 8, background: '#fff' }}>
        <h4>📋 Account Info ({bank})</h4>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {BANK_CONFIG[bank].accountFields.map((field) => (
            <input
              key={field}
              name={field}
              placeholder={field.replace(/_/g, " ").toUpperCase()}
              value={account[field] || ""}
              onChange={handleAccountChange}
              style={{ padding: 8, flex: '1 1 200px', borderRadius: 4, border: '1px solid #ddd' }}
            />
          ))}
        </div>
        <button 
          style={{ 
            marginTop: 10, 
            padding: '10px 20px', 
            background: '#4CAF50', 
            color: 'white', 
            border: 'none', 
            borderRadius: 5, 
            cursor: 'pointer',
            fontWeight: 'bold'
          }} 
          onClick={saveAccount}
        >
          💾 Save Account Info
        </button>
      </div>

      {/* CSV Upload Section */}
      <div style={{ 
        marginTop: 20, 
        padding: 15, 
        border: '2px dashed #4CAF50', 
        borderRadius: 8, 
        background: '#f9fff9' 
      }}>
        <h4>📤 Upload Transactions CSV</h4>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button 
            onClick={downloadCSVTemplate}
            style={{
              padding: '10px 20px',
              background: '#2196F3',
              color: 'white',
              border: 'none',
              borderRadius: 5,
              cursor: 'pointer',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              gap: 5
            }}
          >
            📥 Download {bank} CSV Template
          </button>
          
          <input 
            type="file" 
            accept=".csv"
            onChange={(e) => setFile(e.target.files[0])}
            style={{ padding: 8 }}
          />
          
          <button 
            onClick={handleFileUpload}
            style={{
              padding: '10px 20px',
              background: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: 5,
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
          >
            ⬆️ Upload CSV
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#666', marginTop: 10 }}>
          💡 Tip: Download the template first, fill in your data, then upload it back!
        </p>
      </div>

      {/* Manual Entry */}
      <div style={{ marginTop: 20, border: "1px solid #ddd", padding: 15, borderRadius: 8, background: '#fff' }}>
        <h4>✍️ Manual Transaction Entry</h4>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {BANK_CONFIG[bank].fields.map((field) => (
            <input
              key={field}
              name={field}
              placeholder={field.replace(/_/g, " ").toUpperCase()}
              value={manualTxn[field] || ""}
              onChange={handleTxnChange}
              style={{ padding: 8, flex: '1 1 150px', borderRadius: 4, border: '1px solid #ddd' }}
            />
          ))}
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
          <button 
            style={{ 
              padding: '10px 20px', 
              background: '#4CAF50', 
              color: 'white', 
              border: 'none', 
              borderRadius: 5, 
              cursor: 'pointer',
              fontWeight: 'bold'
            }} 
            onClick={addManualTxn}
          >
            ➕ Add Transaction
          </button>
          <button 
            style={{ 
              padding: '10px 20px', 
              background: '#f44336', 
              color: 'white', 
              border: 'none', 
              borderRadius: 5, 
              cursor: 'pointer',
              fontWeight: 'bold'
            }} 
            onClick={clearTransactions}
          >
            🗑️ Clear All
          </button>
        </div>
      </div>

      {/* Transactions Table */}
      <div style={{ marginTop: 20 }}>
        <h4>📊 Transactions ({bank}) - {transactions.length} entries</h4>
        <div style={{ overflowX: 'auto' }}>
          <table 
            border="1" 
            cellPadding="8" 
            style={{ 
              borderCollapse: "collapse", 
              width: "100%", 
              background: '#fff',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
            }}
          >
            <thead style={{ background: '#4CAF50', color: 'white' }}>
              <tr>
                {BANK_CONFIG[bank].labels.map((label) => (
                  <th key={label} style={{ padding: 10, textAlign: 'left' }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.map((txn, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? '#f9f9f9' : 'white' }}>
                  {BANK_CONFIG[bank].fields.map((f) => (
                    <td key={f} style={{ padding: 8 }}>{txn[f] || ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div style={{ 
          marginTop: 15, 
          padding: 15, 
          background: '#e3f2fd', 
          borderRadius: 8,
          display: 'flex',
          justifyContent: 'space-around',
          flexWrap: 'wrap',
          gap: 10
        }}>
          <div>
            <strong>💰 Total Withdrawal (Debit):</strong> ₹{totalDebit.toFixed(2)}
          </div>
          <div>
            <strong>💵 Total Deposit (Credit):</strong> ₹{totalCredit.toFixed(2)}
          </div>
          <div>
            <strong>📈 Net Balance:</strong> ₹{(totalCredit - totalDebit).toFixed(2)}
          </div>
        </div>
      </div>

      {/* Download PDF */}
      <div style={{ marginTop: 20, textAlign: 'center' }}>
        <button 
          onClick={downloadPDF}
          style={{
            padding: '15px 40px',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 16,
            fontWeight: 'bold',
            boxShadow: '0 4px 6px rgba(0,0,0,0.2)',
            transition: 'transform 0.2s'
          }}
          onMouseOver={(e) => e.target.style.transform = 'scale(1.05)'}
          onMouseOut={(e) => e.target.style.transform = 'scale(1)'}
        >
          📄 Download PDF Statement
        </button>
      </div>
    </div>
  );
}

export default App;
