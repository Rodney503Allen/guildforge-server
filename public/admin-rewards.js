const form = document.getElementById("rewardForm");

const itemSelect = document.getElementById("rewardItemSelect");
const itemQty = document.getElementById("rewardItemQty");
const itemList = document.getElementById("rewardItems");

const btnAdd = document.getElementById("btnAddRewardItem");

let rewardItems = [];

btnAdd.addEventListener("click", () => {

const itemId = itemSelect.value;
const qty = Number(itemQty.value || 1);

if(!itemId) return;

rewardItems.push({
item_id: Number(itemId),
qty
});

renderItems();

});

function renderItems(){

itemList.innerHTML = "";

rewardItems.forEach((it,i)=>{

const div = document.createElement("div");

div.className = "row";

div.innerHTML = `
<div style="flex:1;">Item ID ${it.item_id}</div>
<div>Qty ${it.qty}</div>
<button data-i="${i}" class="btn">Remove</button>
`;

itemList.appendChild(div);

});

itemList.querySelectorAll("button").forEach(btn=>{
btn.onclick = ()=>{
rewardItems.splice(btn.dataset.i,1);
renderItems();
};
});

}

form.addEventListener("submit", async (e)=>{

e.preventDefault();

const data = Object.fromEntries(new FormData(form));

data.items_json = rewardItems;

const res = await fetch("/admin/api/quest-rewards",{
method:"POST",
headers:{ "Content-Type":"application/json" },
body: JSON.stringify(data)
});

const json = await res.json();

if(json.ok){

alert("Rewards saved!");

}else{

alert("Error saving rewards");

}

});