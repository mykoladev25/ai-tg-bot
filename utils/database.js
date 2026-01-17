const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

/**
 * Ініціалізація директорії для даних
 */
async function initDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    console.log('Data directory initialized');
  } catch (error) {
    console.error('Error creating data directory:', error);
  }
}

/**
 * Зберегти дані користувачів у файл
 */
async function saveUsersToFile(usersMap) {
  try {
    await initDataDir();
    
    const usersArray = Array.from(usersMap.entries());
    await fs.writeFile(
      USERS_FILE,
      JSON.stringify(usersArray, null, 2),
      'utf8'
    );
    
    console.log(`Saved ${usersArray.length} users to file`);
    return true;
  } catch (error) {
    console.error('Error saving users:', error);
    return false;
  }
}

/**
 * Завантажити дані користувачів з файлу
 */
async function loadUsersFromFile() {
  try {
    const data = await fs.readFile(USERS_FILE, 'utf8');
    const usersArray = JSON.parse(data);
    
    const usersMap = new Map(usersArray);
    console.log(`Loaded ${usersMap.size} users from file`);
    
    return usersMap;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No users file found, starting fresh');
      return new Map();
    }
    console.error('Error loading users:', error);
    return new Map();
  }
}

/**
 * Періодичне збереження даних
 */
function setupPeriodicSave(usersMap, intervalMinutes = 5) {
  const interval = intervalMinutes * 60 * 1000;
  
  setInterval(async () => {
    await saveUsersToFile(usersMap);
  }, interval);
  
  console.log(`Periodic save scheduled every ${intervalMinutes} minutes`);
}

/**
 * Зберегти при виході з програми
 */
function setupExitHandler(usersMap) {
  const saveAndExit = async (signal) => {
    console.log(`\nReceived ${signal}, saving data...`);
    await saveUsersToFile(usersMap);
    process.exit(0);
  };
  
  process.on('SIGINT', () => saveAndExit('SIGINT'));
  process.on('SIGTERM', () => saveAndExit('SIGTERM'));
  process.on('exit', () => {
    console.log('Process exiting...');
  });
}

/**
 * Створити backup
 */
async function createBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(DATA_DIR, `users_backup_${timestamp}.json`);
    
    await fs.copyFile(USERS_FILE, backupFile);
    console.log(`Backup created: ${backupFile}`);
    
    return backupFile;
  } catch (error) {
    console.error('Error creating backup:', error);
    return null;
  }
}

/**
 * Очистити старі backup файли
 */
async function cleanOldBackups(keepLast = 5) {
  try {
    const files = await fs.readdir(DATA_DIR);
    const backupFiles = files
      .filter(f => f.startsWith('users_backup_'))
      .sort()
      .reverse();
    
    if (backupFiles.length > keepLast) {
      const toDelete = backupFiles.slice(keepLast);
      
      for (const file of toDelete) {
        await fs.unlink(path.join(DATA_DIR, file));
        console.log(`Deleted old backup: ${file}`);
      }
    }
  } catch (error) {
    console.error('Error cleaning backups:', error);
  }
}

module.exports = {
  initDataDir,
  saveUsersToFile,
  loadUsersFromFile,
  setupPeriodicSave,
  setupExitHandler,
  createBackup,
  cleanOldBackups
};
