const firebaseConfig = {
  apiKey: "AIzaSyDFQCMsX04fwh7MVyEpvXnXD0U4TD5Or5w",
  authDomain: "ja-barbearia.firebaseapp.com",
  databaseURL: "https://ja-barbearia-default-rtdb.firebaseio.com",
  projectId: "ja-barbearia",
  storageBucket: "ja-barbearia.firebasestorage.app",
  messagingSenderId: "213237027963",
  appId: "1:213237027963:web:7d585b158ee06d3ab7fede"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

function hojeStr(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + dia;
}

function diaSemanaNum(d) {
  d = d || new Date();
  return d.getDay();
}

function horaAgora(d) {
  d = d || new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function diffMins(prevista, real) {
  if (!prevista || !real || prevista.length < 4 || real.length < 4) return null;
  const p = prevista.split(":").map(Number);
  const r = real.split(":").map(Number);
  if (p.length < 2 || r.length < 2 || isNaN(p[0]) || isNaN(r[0])) return null;
  return r[0] * 60 + r[1] - (p[0] * 60 + p[1]);
}

function formatarData(d) {
  d = new Date(d);
  d.setHours(12, 0, 0, 0);
  const s = d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function urlEquipe(uid) {
  return new URL("leitor.html?id=" + uid, window.location.href).href;
}