const express = require('express');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

// --- CONFIGURAÇÃO ---
const app = express();
const port = process.env.PORT || 3000;

// Validação de Segurança (Para não rodar se faltar chave)
if (!process.env.SUPABASE_URL || !process.env.VAPID_PRIVATE_KEY) {
    console.error("❌ ERRO FATAL: Variáveis de ambiente não configuradas no Render.");
    process.exit(1);
}

// Configuração do Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Configuração VAPID
const publicVapidKey = 'BJ3Kcc4a7oO9QbHM1msWRhlkuTGJCk8Pdvko0mTqwHnvxXvCGn7ZEihd0Tlt9RJcVHlZBQQfmfp6Pl02FZ0ER9I';
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  'mailto:seu-email@exemplo.com', // Pode manter assim ou por o seu real
  publicVapidKey,
  privateVapidKey
);

// --- FUNÇÃO PRINCIPAL (ROBÔ) ---
async function verificarNotificacoes() {
  console.log("------------------------------------------------");
  // Ajuste de Fuso Horário (Brasil -3h)
  const now = new Date();
  now.setHours(now.getHours() - 3);

  const todayStr = now.toISOString().split('T')[0];
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();
  const currentTimeVal = currentHour * 60 + currentMin;

  console.log(`🕒 Hora Servidor (Brasil): ${currentHour.toString().padStart(2, '0')}:${currentMin.toString().padStart(2, '0')}`);

  // 1. Buscar tarefas pendentes de hoje
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('task_date', todayStr)
    .eq('completed', false);

  if (error) {
    console.error("❌ Erro ao ler banco:", error.message);
    return;
  }

  if (!tasks || tasks.length === 0) {
    console.log("📭 Nenhuma tarefa pendente agora.");
    return;
  }

  // 2. Loop pelas tarefas
  for (const task of tasks) {
    if (!task.task_time) continue;

    const [h, m] = task.task_time.split(':').map(Number);
    const taskTimeVal = h * 60 + m;
    const diff = taskTimeVal - currentTimeVal;

    let message = '';
    let type = '';
    let statusLog = '';

    // Regra 1: Aviso de 30 min (entre 25 e 31 antes)
    if (diff <= 31 && diff >= 25) {
      if (!task.notif_30m_sent) {
        message = `⏰ Preparar! "${task.text}" começa em 30 min.`;
        type = '30m';
        statusLog = "✅ Gatilho 30min!";
      } else statusLog = "⏸️ Já avisado (30m).";
    }
    // Regra 2: Hora Exata (aceita até 60 min de atraso)
    else if (diff <= 0 && diff >= -60) {
      if (!task.notif_exact_sent) {
        message = `🔔 Hora de: "${task.text}"!`;
        type = 'exact';
        statusLog = "✅ Gatilho Hora Exata!";
      } else statusLog = "⏸️ Já avisado (Exato).";
    } else {
      statusLog = `⏳ Aguardando (Diff: ${diff} min)`;
    }

    console.log(`📋 [${task.task_time}] "${task.text}" | ${statusLog}`);

    // 3. ENVIO REAL (Aqui estava o problema antes)
    if (message) {
      console.log(`   🚀 Iniciando envio para User ID: ${task.user_id}...`);
      
      // Buscar inscrições do usuário
      const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('id, subscription')
        .eq('user_id', task.user_id);

      if (subs && subs.length > 0) {
        let sentCount = 0;
        for (const subRecord of subs) {
          try {
            await webpush.sendNotification(subRecord.subscription, JSON.stringify({
              title: 'Lembrete de Tarefa',
              body: message,
              icon: '/icon-192.png' // Certifique-se que existe no seu site
            }));
            sentCount++;
            console.log("      -> Sucesso! Push enviado.");
          } catch (err) {
            // Se der erro 410 (Gone), apaga a inscrição velha
            if (err.statusCode === 410) {
              console.log(`      🗑️ Inscrição morta (410). Removendo ID: ${subRecord.id}`);
              await supabase.from('push_subscriptions').delete().eq('id', subRecord.id);
            } else {
              console.error("      -> Falha no envio:", err.message);
            }
          }
        }
        
        // SÓ ATUALIZA O BANCO SE TENTOU ENVIAR
        // (Mesmo se falhar, marcamos como enviado para não ficar tentando eternamente e gastando CPU)
        const updateField = type === '30m' ? { notif_30m_sent: true } : { notif_exact_sent: true };
        const { error: updateError } = await supabase.from('tasks').update(updateField).eq('id', task.id);
        
        if(updateError) console.error("      ❌ Erro ao atualizar tarefa:", updateError.message);
        else console.log("      ✅ Tarefa marcada como notificada no banco.");

      } else {
         console.log("      ⚠️ Usuário não tem inscrições de Push ativas.");
      }
    }
  }
}

// --- SERVIDOR WEB ---
app.get('/', (req, res) => {
  res.send('Notificador de Tarefas Online 🤖');
});

app.listen(port, () => {
  console.log(`📡 Servidor Render rodando na porta ${port}`);
  
  // Executa imediatamente ao ligar
  verificarNotificacoes();

  // Executa a cada 60 segundos (Loop)
  setInterval(verificarNotificacoes, 60 * 1000);
});
