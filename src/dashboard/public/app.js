document.addEventListener("DOMContentLoaded", function () {
  var dot = document.getElementById("status-dot");
  var text = document.getElementById("status-text");
  var serverName = document.getElementById("server-name");

  fetch("/api/health")
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      dot.className = "status-dot connected";
      text.textContent = "Connected";
      if (data.server) {
        serverName.textContent = "Server: " + data.server;
      }
    })
    .catch(function () {
      dot.className = "status-dot disconnected";
      text.textContent = "Disconnected";
      serverName.textContent = "";
    });
});
