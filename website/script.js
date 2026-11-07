const copyButton = document.querySelector(".command-wrap [data-copy]");
const commandLabel = document.querySelector("#command-label");
const commandValue = document.querySelector("#command-value");
const commandNote = document.querySelector("#command-note");
const commandModes = document.querySelectorAll("[data-mode]");

const commandOptions = {
  global: {
    label: "Use one workspace from any folder",
    command: "npx @andrestobelem/clone@0.4.0",
    notes: ["Stores data in your user directory", "Available from any folder"],
  },
  local: {
    label: "Use one workspace for this repository",
    command: "npx @andrestobelem/clone@0.4.0 --local",
    notes: ["Creates ./.clone/", "Separate workspace per repository", "Ignore .clone/ in Git"],
  },
};

function selectCommand(mode) {
  const option = commandOptions[mode];
  if (!option) return;
  commandLabel.textContent = option.label;
  commandValue.textContent = option.command;
  copyButton.dataset.copy = option.command;
  commandNote.replaceChildren(...option.notes.map((note) => {
    const span = document.createElement("span");
    span.textContent = note;
    return span;
  }));
  for (const button of commandModes) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

for (const button of commandModes) {
  button.addEventListener("click", () => selectCommand(button.dataset.mode));
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const label = button.querySelector("span");
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.classList.add("copied");
      label.textContent = "Copied";
      window.setTimeout(() => {
        button.classList.remove("copied");
        label.textContent = "Copy";
      }, 1800);
    } catch {
      label.textContent = "Select";
    }
  });
}

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.classList.add("visible");
      observer.unobserve(entry.target);
    }
  }
}, { threshold: 0.12 });

document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
