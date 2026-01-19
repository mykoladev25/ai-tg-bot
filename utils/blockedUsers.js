const BlockedUser = require('../database/models/BlockedUser');

/**
 * Заблокувати користувача
 */
async function blockUser(userId, username, firstName, blockedBy, reason = 'Manual block', notes = '') {
  try {
    const blockedUser = new BlockedUser({
      _id: userId,
      username,
      firstName,
      reason,
      blockedBy,
      notes
    });

    await blockedUser.save();
    console.log(`🚫 User ${userId} blocked: ${reason}`);
    return true;
  } catch (error) {
    console.error('❌ Error blocking user:', error.message);
    return false;
  }
}

/**
 * Розблокувати користувача
 */
async function unblockUser(userId) {
  try {
    const result = await BlockedUser.findByIdAndDelete(userId);
    if (result) {
      console.log(`✅ User ${userId} unblocked`);
      return true;
    } else {
      console.log(`ℹ️ User ${userId} not found in blocked list`);
      return false;
    }
  } catch (error) {
    console.error('❌ Error unblocking user:', error.message);
    return false;
  }
}

/**
 * Перевірити чи користувач заблокований
 */
async function isUserBlocked(userId) {
  try {
    const blockedUser = await BlockedUser.findById(userId);
    return !!blockedUser;
  } catch (error) {
    console.error('❌ Error checking blocked user:', error.message);
    return false;
  }
}

/**
 * Отримати список всіх заблокованих
 */
async function getAllBlockedUsers() {
  try {
    const blockedUsers = await BlockedUser.find().sort({ blockedAt: -1 });
    return blockedUsers;
  } catch (error) {
    console.error('❌ Error fetching blocked users:', error.message);
    return [];
  }
}

/**
 * Отримати інформацію про заблокованого користувача
 */
async function getBlockedUserInfo(userId) {
  try {
    const blockedUser = await BlockedUser.findById(userId);
    return blockedUser;
  } catch (error) {
    console.error('❌ Error fetching blocked user info:', error.message);
    return null;
  }
}

module.exports = {
  blockUser,
  unblockUser,
  isUserBlocked,
  getAllBlockedUsers,
  getBlockedUserInfo
};

