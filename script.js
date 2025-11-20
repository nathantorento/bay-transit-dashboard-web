fakeData = [
    {
        line: "J",
        destination: "Downtown (Inbound)",
        arrivals: [5, 12, 20]
    },
    {
        line: "33",
        destination: "SF General Hospital (Eastbound)",
        arrivals: [3, 15, 27]
    }
];

function renderEntries() {
    const containerEl = document.getElementById("container");
    containerEl.innerHTML = "";

    fakeData.forEach(line => {
        // Container for each line
        const lineEl = document.createElement("div");
        lineEl.className = "transit-line";;
        
        // Logo
        const logoEl = document.createElement("div");
        logoEl.className = "transit-line-logo";
        logoEl.innerText = line.line;

        // Destination
        const destEl = document.createElement("div");
        destEl.className = "transit-line-destination";
        destEl.innerText = line.destination;

        // Arrival times
        const arrivalsEl = document.createElement("div")
        arrivalsEl.className = "transit-line-arrivals";
        arrivalsEl.innerText = line.arrivals;

        lineEl.append(logoEl, destEl, arrivalsEl)
        containerEl.appendChild(lineEl);
    });
};

renderEntries()