const BlockedUser = require('../database/models/BlockedUser');

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
    console.log(`User ${userId} blocked: ${reason}`);
    return true;
  } catch (error) {
    console.error('Error blocking user:', error.message);
    return false;
  }
}

async function unblockUser(userId) {
  try {
    const result = await BlockedUser.findByIdAndDelete(userId);
    if (!result) {
      console.log(`Blocked user ${userId} was not found`);
      return false;
    }

    console.log(`User ${userId} unblocked`);
    return true;
  } catch (error) {
    console.error('Error unblocking user:', error.message);
    return false;
  }
}

async function isUserBlocked(userId) {
  try {
    return Boolean(await BlockedUser.findById(userId));
  } catch (error) {
    console.error('Error checking blocked user:', error.message);
    return false;
  }
}

async function getAllBlockedUsers() {
  try {
    return await BlockedUser.find().sort({ blockedAt: -1 });
  } catch (error) {
    console.error('Error fetching blocked users:', error.message);
    return [];
  }
}

async function getBlockedUserInfo(userId) {
  try {
    return await BlockedUser.findById(userId);
  } catch (error) {
    console.error('Error fetching blocked user info:', error.message);
    return null;
  }
}

module.exports = {
  blockUser,
  getAllBlockedUsers,
  getBlockedUserInfo,
  isUserBlocked,
  unblockUser
};
