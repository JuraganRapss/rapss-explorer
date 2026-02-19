import readline from "readline";
import fetch from "node-fetch";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let currentAddress = null;
let historyList = [];

function banner() {
  console.clear();
  console.log("\x1b[33m========================================\x1b[0m");
  console.log("\x1b[33m          RAPSS  EXPLORER               \x1b[0m");
  console.log("\x1b[33m========================================\x1b[0m");
  console.log("\x1b[36m⚡ Bitcoin Real-Time Address Tracker\x1b[0m\n");
}

function isValidBTC(address) {
  return /^(1|3|bc1)[a-zA-Z0-9]{20,}$/i.test(address.trim());
}

async function fetchBTC(address) {
  try {
    const res = await fetch(`https://blockchain.info/rawaddr/${address}`);
    const data = await res.json();

    console.log("\n\x1b[33m========== ADDRESS DATA ==========\x1b[0m\n");
    console.log("Address        :", address);
    console.log("\x1b[32mBalance (BTC)  :", data.final_balance / 1e8, "\x1b[0m");
    console.log("Total Received :", data.total_received / 1e8);
    console.log("Total Sent     :", data.total_sent / 1e8);
    console.log("Transactions   :", data.n_tx);
    console.log("\n");
  } catch (err) {
    console.log("Failed to fetch data.");
  }
}

function prompt() {
  rl.question("rapss> ", async (cmd) => {
    const input = cmd.trim();

    if (input === "track") {
      rl.question("Bitcoin Address: ", async (addr) => {
        const cleanAddr = addr.trim();

        if (!isValidBTC(cleanAddr)) {
          console.log("Invalid address\n");
          return prompt();
        }

        currentAddress = cleanAddr;
        historyList.push(cleanAddr);
        await fetchBTC(cleanAddr);
        prompt();
      });

    } else if (input === "refresh") {
      if (!currentAddress) {
        console.log("No address tracked yet.\n");
        return prompt();
      }
      await fetchBTC(currentAddress);
      prompt();

    } else if (input === "history") {
      console.log("\n\x1b[33mTracked History:\x1b[0m");
      if (historyList.length === 0) {
        console.log("No tracked addresses.\n");
      } else {
        historyList.forEach((addr, i) => {
          console.log(`${i + 1}. ${addr}`);
        });
        console.log("");
      }
      prompt();

    } else if (input === "exit") {
      console.log("Goodbye.");
      rl.close();

    } else {
      console.log("Unknown command\n");
      prompt();
    }
  });
}

banner();
prompt();
